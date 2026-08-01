/*
 * os-helper.c — trusted phased launch helper for the AgentOctopus OS backend
 * (Plan 4, Task 3). Part of the Trusted Computing Base.
 *
 * Compiled by scripts/build-os-helper.mjs into a STATIC, fully self-contained
 * binary (`runtime/os-helper`) and digest-verified by verifyHelperArtifact()
 * immediately before every launch. This file is freestanding C that uses
 * syscalls directly — it never invokes a shell, never dlopen()s, and never
 * reads configuration from anywhere but the single launch-spec JSON passed
 * on the command line.
 *
 * Invocation (argument array, never shell):
 *   os-helper --launch-spec <path> --stop-before-exec
 *
 * The helper runs as root in three explicit phases:
 *
 *   Phase 1 — OUTSIDE chroot:
 *     - open the named netns fd (from spec.netnsPath)
 *     - setns(netnsFd, CLONE_NEWNET)   [BEFORE the userns pivot — setns into a
 *       pre-existing netns needs CAP_SYS_ADMIN in the CURRENT user namespace,
 *       which the CLONE_NEWUSER unshare below would drop (EPERM). setns touches
 *       only the net ns, so the pivot leaves the joined net ns in place.]
 *     - unshare(CLONE_NEWUSER|CLONE_NEWNS|CLONE_NEWPID|CLONE_NEWIPC|CLONE_NEWUTS)
 *     - write uid_map/gid_map (root in-ns → real root out-ns)
 *     - mount(NULL, "/", NULL, MS_REC|MS_PRIVATE, NULL)  — propagation private
 *     - bind verified runtime root onto itself, remount MS_BIND|MS_REMOUNT|MS_RDONLY
 *     - for each hostBinds[] entry: bind source→target, remount
 *       ro,nosuid,nodev (skill also noexec only when the strategy allows)
 *
 *   Phase 2 — STILL OUTSIDE chroot:
 *     - mount private tmpfs on <root>/tmp and <root>/dev
 *     - create only the required device nodes (null, zero, full, random,
 *       urandom) and fd links (stdin/stdout/stderr to /proc/self/fd/N)
 *     - fork() so the untrusted process is PID 1 in the new PID namespace
 *
 *   Phase 3 — ENTER root (child only):
 *     - chroot(root), chdir(cwd)
 *     - mount("proc", "/proc", "proc", MS_NOSUID|MS_NOEXEC|MS_NODEV, NULL)
 *     - verify runtime root and skill mounts are read-only (parse
 *       /proc/self/mountinfo; refuse to exec if any is RW)
 *     - prctl(PR_SET_NO_NEW_PRIVS, 1)
 *     - setgroups(0, NULL), setgid(spec.gid), setuid(spec.uid)   [65534]
 *     - clearenv(), then install ONLY the allowlisted spec.env
 *     - execve(command[0], command, envp)
 *
 * After chroot the helper references ONLY /skill, /tmp, /proc, /dev,
 * /etc/skill-ca/ca.pem, and the declared runtime executable from the spec.
 * It NEVER uses layout.root + "/tmp" after chroot, NEVER runs /bin/sh -c,
 * NEVER execs setpriv, and NEVER performs an anonymous `unshare --net`
 * (the netns is always the named one passed in via the spec).
 *
 * --stop-before-exec: the child raises SIGSTOP immediately before the
 * PR_SET_NO_NEW_PRIVS/execve boundary so the launcher can attach the child
 * PID to the session cgroup; SIGCONT completes phase 3.
 *
 * Fail-closed: every syscall is checked; any failure writes a single-line
 * diagnostic to fd 2 and _exit(127). There is no recovery path and no
 * partial-launch state.
 *
 * Build: cc -static -O2 -o runtime/os-helper src/os/helper.c
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <sched.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

#define OCT_MAX_CMD_ARGS   256
#define OCT_MAX_ENV         64
#define OCT_MAX_BINDS       16
#define OCT_PATH_MAX_LEN  4096

/* In-root mount targets the helper may reference AFTER chroot. This is the
 * exhaustive allowlist — anything else is a bug. */
#define INROOT_SKILL    "/skill"
#define INROOT_TMP      "/tmp"
#define INROOT_PROC     "/proc"
#define INROOT_DEV      "/dev"
#define INROOT_CA       "/etc/skill-ca/ca.pem"

/* ------------------------------------------------------------------ */
/* Launch-spec model (parsed from JSON)                                */
/* ------------------------------------------------------------------ */

typedef struct {
    char source[OCT_PATH_MAX_LEN];
    char target[OCT_PATH_MAX_LEN];
    int  recursive; /* boolean */
} HostBind;

typedef struct {
    char     root[OCT_PATH_MAX_LEN];
    char     netnsPath[OCT_PATH_MAX_LEN];
    HostBind hostBinds[OCT_MAX_BINDS];
    int      hostBindsLen;
    uint64_t tmpSizeBytes;
    uint64_t devSizeBytes;
    uid_t    uid;
    gid_t    gid;
    char     cwd[OCT_PATH_MAX_LEN];
    char    *command[OCT_MAX_CMD_ARGS];
    int      commandLen;
    /* env as parallel key/value arrays */
    char    *envKeys[OCT_MAX_ENV];
    char    *envVals[OCT_MAX_ENV];
    int      envLen;
} LaunchSpec;

/* ------------------------------------------------------------------ */
/* Diagnostics + fatal                                                 */
/* ------------------------------------------------------------------ */

static void die(const char *fmt, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    if (n > 0) {
        (void)!write(STDERR_FILENO, "os-helper: ", 11);
        (void)!write(STDERR_FILENO, buf, (size_t)n < sizeof(buf) ? (size_t)n : sizeof(buf));
        (void)!write(STDERR_FILENO, "\n", 1);
    }
    _exit(127);
}

static void die_errno(const char *what) {
    die("%s: %s", what, strerror(errno));
}

/* ------------------------------------------------------------------ */
/* Minimal JSON extraction                                             */
/*                                                                     */
/* The launch spec is produced by our own run-spec.ts (a JSON.stringify  */
/* of a fixed-shape object). We deliberately do NOT ship a general JSON  */
/* parser in the TCB. Instead we extract the small set of fields we     */
/* need with a strict, fail-closed scanner that understands exactly    */
/* the shapes JSON.stringify can emit for them. Any deviation dies.    */
/* ------------------------------------------------------------------ */

typedef struct {
    const char *cur;
    const char *end;
} Scanner;

static void skip_ws(Scanner *s) {
    while (s->cur < s->end && (*s->cur == ' ' || *s->cur == '\t' ||
                              *s->cur == '\n' || *s->cur == '\r'))
        s->cur++;
}

static int peek(Scanner *s) { skip_ws(s); return s->cur < s->end ? *s->cur : -1; }

static void expect(Scanner *s, char c) {
    skip_ws(s);
    if (s->cur >= s->end || *s->cur != c)
        die("launch spec parse error: expected '%c'", c);
    s->cur++;
}

/* Parse a JSON string into out (NUL-terminated, max outLen-1 chars).
 * Handles the escapes JSON.stringify can produce. Dies on truncation or
 * an out-of-range codepoint. Returns number of bytes written. */
static size_t parse_string(Scanner *s, char *out, size_t outLen) {
    expect(s, '"');
    size_t n = 0;
    while (s->cur < s->end && *s->cur != '"') {
        char c = *s->cur++;
        if ((unsigned char)c < 0x20)
            die("launch spec parse error: raw control char in string");
        if (c == '\\') {
            if (s->cur >= s->end) die("launch spec parse error: dangling escape");
            char e = *s->cur++;
            switch (e) {
                case '"': c = '"'; break;
                case '\\': c = '\\'; break;
                case '/': c = '/'; break;
                case 'b': c = '\b'; break;
                case 'f': c = '\f'; break;
                case 'n': c = '\n'; break;
                case 'r': c = '\r'; break;
                case 't': c = '\t'; break;
                case 'u': {
                    /* \uXXXX — only accept ASCII range; the spec is ASCII. */
                    if (s->end - s->cur < 4) die("launch spec parse error: short \\u escape");
                    unsigned v = 0;
                    for (int i = 0; i < 4; i++) {
                        char h = *s->cur++;
                        v <<= 4;
                        if (h >= '0' && h <= '9') v |= (unsigned)(h - '0');
                        else if (h >= 'a' && h <= 'f') v |= (unsigned)(h - 'a' + 10);
                        else if (h >= 'A' && h <= 'F') v |= (unsigned)(h - 'A' + 10);
                        else die("launch spec parse error: bad \\u escape");
                    }
                    if (v > 0x7f) die("launch spec: non-ASCII \\u escape not supported");
                    /* Apply the SAME control-char rejection to the DECODED
                     * value as the raw-byte path above, and reject NUL
                     * outright — parsed strings become C strings (argv, cwd,
                     * env) where an embedded NUL silently truncates. No
                     * escape sequence may introduce a byte < 0x20. */
                    if (v == 0) die("launch spec: \\u0000 (NUL) is never legitimate in a string");
                    if (v < 0x20) die("launch spec parse error: control char in \\u escape");
                    c = (char)v;
                    break;
                }
                default:
                    die("launch spec parse error: unknown escape '\\%c'", e);
            }
        }
        if (n + 1 >= outLen) die("launch spec: string too long");
        out[n++] = c;
    }
    if (s->cur >= s->end) die("launch spec parse error: unterminated string");
    s->cur++; /* closing quote */
    out[n] = '\0';
    return n;
}

/* Parse a JSON number as unsigned 64-bit. Dies on non-digit/negative. */
static uint64_t parse_u64(Scanner *s) {
    skip_ws(s);
    if (s->cur >= s->end || *s->cur < '0' || *s->cur > '9')
        die("launch spec parse error: expected unsigned number");
    uint64_t v = 0;
    while (s->cur < s->end && *s->cur >= '0' && *s->cur <= '9') {
        uint64_t nv = v * 10 + (uint64_t)(*s->cur - '0');
        if (nv < v) die("launch spec parse error: u64 overflow");
        v = nv;
        s->cur++;
    }
    return v;
}

/* Parse a JSON boolean. */
static int parse_bool(Scanner *s) {
    skip_ws(s);
    if (s->end - s->cur >= 4 && memcmp(s->cur, "true", 4) == 0) { s->cur += 4; return 1; }
    if (s->end - s->cur >= 5 && memcmp(s->cur, "false", 5) == 0) { s->cur += 5; return 0; }
    die("launch spec parse error: expected boolean");
    return 0;
}

/* Skip an arbitrary JSON value (used for unknown keys — the strict schema
 * is enforced by run-spec.ts; the helper ignores unknowns defensively). */
static void skip_value(Scanner *s);

static void skip_object(Scanner *s) {
    expect(s, '{');
    if (peek(s) == '}') { s->cur++; return; }
    for (;;) {
        char k[64];
        parse_string(s, k, sizeof(k));
        expect(s, ':');
        skip_value(s);
        int c = peek(s);
        if (c == ',') { s->cur++; continue; }
        if (c == '}') { s->cur++; return; }
        die("launch spec parse error: expected ',' or '}' in object");
    }
}

static void skip_array(Scanner *s) {
    expect(s, '[');
    if (peek(s) == ']') { s->cur++; return; }
    for (;;) {
        skip_value(s);
        int c = peek(s);
        if (c == ',') { s->cur++; continue; }
        if (c == ']') { s->cur++; return; }
        die("launch spec parse error: expected ',' or ']' in array");
    }
}

static void skip_value(Scanner *s) {
    int c = peek(s);
    if (c == '{') { skip_object(s); return; }
    if (c == '[') { skip_array(s); return; }
    if (c == '"') { char tmp[1]; (void)tmp; char buf[OCT_PATH_MAX_LEN]; parse_string(s, buf, sizeof(buf)); return; }
    if (c == 't' || c == 'f') { (void)parse_bool(s); return; }
    if (c == 'n') {
        if (s->end - s->cur >= 4 && memcmp(s->cur, "null", 4) == 0) { s->cur += 4; return; }
        die("launch spec parse error: bad null");
    }
    if (c == '-' || (c >= '0' && c <= '9')) {
        /* skip a number (possibly negative/float in unknown fields) */
        s->cur++;
        while (s->cur < s->end && (strchr("0123456789+-.eE", *s->cur) != NULL)) s->cur++;
        return;
    }
    die("launch spec parse error: unexpected value");
}

/* Parse the hostBinds array. */
static void parse_host_binds(Scanner *s, LaunchSpec *out) {
    expect(s, '[');
    if (peek(s) == ']') { s->cur++; return; }
    for (;;) {
        if (out->hostBindsLen >= OCT_MAX_BINDS) die("launch spec: too many hostBinds");
        HostBind *b = &out->hostBinds[out->hostBindsLen];
        int haveSource = 0, haveTarget = 0, haveRecursive = 0;
        expect(s, '{');
        if (peek(s) != '}') {
            for (;;) {
                char key[64];
                parse_string(s, key, sizeof(key));
                expect(s, ':');
                if (strcmp(key, "source") == 0) {
                    parse_string(s, b->source, sizeof(b->source)); haveSource = 1;
                } else if (strcmp(key, "target") == 0) {
                    parse_string(s, b->target, sizeof(b->target)); haveTarget = 1;
                } else if (strcmp(key, "recursive") == 0) {
                    b->recursive = parse_bool(s); haveRecursive = 1;
                } else {
                    skip_value(s);
                }
                int c = peek(s);
                if (c == ',') { s->cur++; continue; }
                if (c == '}') { s->cur++; break; }
                die("launch spec parse error: expected ',' or '}' in hostBind");
            }
        } else {
            s->cur++;
        }
        if (!haveSource || !haveTarget || !haveRecursive)
            die("launch spec: hostBind missing source/target/recursive");
        out->hostBindsLen++;
        int c = peek(s);
        if (c == ',') { s->cur++; continue; }
        if (c == ']') { s->cur++; return; }
        die("launch spec parse error: expected ',' or ']' in hostBinds");
    }
}

/* Parse the command array into out->command (heap-allocated strings). */
static void parse_command(Scanner *s, LaunchSpec *out) {
    expect(s, '[');
    if (peek(s) == ']') { s->cur++; return; }
    for (;;) {
        if (out->commandLen >= OCT_MAX_CMD_ARGS - 1) die("launch spec: too many command args");
        char buf[OCT_PATH_MAX_LEN];
        parse_string(s, buf, sizeof(buf));
        out->command[out->commandLen] = strdup(buf);
        if (!out->command[out->commandLen]) die_errno("strdup");
        out->commandLen++;
        int c = peek(s);
        if (c == ',') { s->cur++; continue; }
        if (c == ']') { s->cur++; break; }
        die("launch spec parse error: expected ',' or ']' in command");
    }
}

/* Parse the env object into parallel key/value arrays. */
static void parse_env(Scanner *s, LaunchSpec *out) {
    expect(s, '{');
    if (peek(s) == '}') { s->cur++; return; }
    for (;;) {
        if (out->envLen >= OCT_MAX_ENV) die("launch spec: too many env entries");
        char k[256], v[OCT_PATH_MAX_LEN];
        parse_string(s, k, sizeof(k));
        expect(s, ':');
        parse_string(s, v, sizeof(v));
        out->envKeys[out->envLen] = strdup(k);
        out->envVals[out->envLen] = strdup(v);
        if (!out->envKeys[out->envLen] || !out->envVals[out->envLen]) die_errno("strdup");
        out->envLen++;
        int c = peek(s);
        if (c == ',') { s->cur++; continue; }
        if (c == '}') { s->cur++; break; }
        die("launch spec parse error: expected ',' or '}' in env");
    }
}

static void parse_launch_spec(const char *json, size_t len, LaunchSpec *out) {
    Scanner s = { .cur = json, .end = json + len };
    memset(out, 0, sizeof(*out));

    int haveRoot = 0, haveNetns = 0, haveCwd = 0, haveCmd = 0;
    expect(&s, '{');
    if (peek(&s) == '}') { s.cur++; die("launch spec: empty object"); }
    for (;;) {
        char key[64];
        parse_string(&s, key, sizeof(key));
        expect(&s, ':');
        if (strcmp(key, "root") == 0) {
            parse_string(&s, out->root, sizeof(out->root)); haveRoot = 1;
        } else if (strcmp(key, "netnsPath") == 0) {
            parse_string(&s, out->netnsPath, sizeof(out->netnsPath)); haveNetns = 1;
        } else if (strcmp(key, "hostBinds") == 0) {
            parse_host_binds(&s, out);
        } else if (strcmp(key, "tmpSizeBytes") == 0) {
            out->tmpSizeBytes = parse_u64(&s);
        } else if (strcmp(key, "devSizeBytes") == 0) {
            out->devSizeBytes = parse_u64(&s);
        } else if (strcmp(key, "uid") == 0) {
            out->uid = (uid_t)parse_u64(&s);
        } else if (strcmp(key, "gid") == 0) {
            out->gid = (gid_t)parse_u64(&s);
        } else if (strcmp(key, "cwd") == 0) {
            parse_string(&s, out->cwd, sizeof(out->cwd)); haveCwd = 1;
        } else if (strcmp(key, "command") == 0) {
            parse_command(&s, out); haveCmd = 1;
        } else if (strcmp(key, "env") == 0) {
            parse_env(&s, out);
        } else {
            skip_value(&s);
        }
        int c = peek(&s);
        if (c == ',') { s.cur++; continue; }
        if (c == '}') { s.cur++; break; }
        die("launch spec parse error: expected ',' or '}' at top level");
    }
    skip_ws(&s);
    if (s.cur != s.end) die("launch spec: trailing garbage after top-level object");

    if (!haveRoot) die("launch spec: missing root");
    if (!haveNetns) die("launch spec: missing netnsPath");
    if (!haveCwd) die("launch spec: missing cwd");
    if (!haveCmd || out->commandLen == 0) die("launch spec: missing/empty command");

    /* Structural validation: phase-3 paths must be in-root absolute and must
     * never reference the host staging root. */
    if (out->cwd[0] != '/') die("launch spec: cwd must be absolute");
    if (strstr(out->cwd, "..")) die("launch spec: cwd must not contain '..'");
    if (strncmp(out->cwd, out->root, strlen(out->root)) == 0)
        die("launch spec: cwd references the host staging root");
    if (out->command[0][0] != '/') die("launch spec: command[0] must be absolute");
    if (strncmp(out->command[0], out->root, strlen(out->root)) == 0)
        die("launch spec: command[0] references the host staging root");
}

/* ------------------------------------------------------------------ */
/* Syscall wrappers                                                    */
/* ------------------------------------------------------------------ */

static void xwrite_file(const char *path, const char *data) {
    int fd = open(path, O_WRONLY | O_CLOEXEC);
    if (fd < 0) die_errno(path);
    size_t len = strlen(data);
    ssize_t n = write(fd, data, len);
    if (n < 0 || (size_t)n != len) die_errno(path);
    if (close(fd) < 0) die_errno(path);
}

static void xmount(const char *src, const char *target, const char *fstype,
                   unsigned long flags, const char *data) {
    if (mount(src, target, fstype, flags, data) < 0) {
        die("mount(%s -> %s, %s, 0x%lx): %s",
            src ? src : "NULL", target, fstype ? fstype : "NULL", flags,
            strerror(errno));
    }
}

/* ------------------------------------------------------------------ */
/* Phase 1 — outside chroot                                            */
/* ------------------------------------------------------------------ */

static void phase1_outside_chroot(const LaunchSpec *spec, int *outNetnsFd) {
    /* Open the named netns fd before any pivot. */
    int netnsFd = open(spec->netnsPath, O_RDONLY | O_CLOEXEC);
    if (netnsFd < 0)
        die("open netns %s: %s", spec->netnsPath, strerror(errno));

    /* Join the named netns BEFORE the user-namespace pivot. setns(CLONE_NEWNET)
     * into a pre-existing netns requires CAP_SYS_ADMIN in the CURRENT (real,
     * root-owned) user namespace. unshare(CLONE_NEWUSER) immediately drops that
     * capability (the process becomes root only of the fresh userns, which does
     * not own the named netns), so calling setns after the pivot fails with
     * EPERM. Joining first is safe: setns changes ONLY the network namespace —
     * the subsequent unshare(CLONE_NEWUSER|CLONE_NEWNS|CLONE_NEWPID|...) creates
     * the mount/pid/ipc/uts/user namespaces fresh while leaving the just-joined
     * net namespace in place, so the helper keeps the named netns through the
     * pivot. NEVER an anonymous `unshare --net`: the net namespace is always the
     * named one provided by the launcher. */
    if (setns(netnsFd, CLONE_NEWNET) < 0)
        die_errno("setns(netnsFd, CLONE_NEWNET)");

    /* Capture the real (pre-pivot) uid/gid BEFORE unshare: inside the fresh
     * user namespace getuid()/getgid() return the overflow id (65534) because
     * no uid_map exists yet, which would build an invalid "0 65534 1" map and
     * fail the uid_map write with EPERM. */
    uid_t ruid = getuid();
    gid_t rgid = getgid();
    if (unshare(CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWIPC | CLONE_NEWUTS) < 0)
        die_errno("unshare(NEWUSER|NEWNS|NEWPID|NEWIPC|NEWUTS)");

    /* uid_map/gid_map: in-ns uid 0 → real uid, so root-owned files (the
     * verified runtime root) remain accessible.
     *
     * /proc/self/setgroups "deny" is required ONLY for an UNPRIVILEGED caller:
     * without CAP_SETGID in the parent user namespace the kernel refuses the
     * gid_map write until setgroups is denied (user_namespaces(7)). "deny" is
     * a per-userns, IRREVERSIBLE flag (USERNS_SETGROUPS_ALLOWED): once written
     * it permanently disables setgroups(2) for every process in the namespace,
     * which would kill the child's setgroups(0, NULL) drop in phase 3 with
     * EPERM (and cannot be undone — writing "allow" back is EPERM).
     *
     * A root caller (the privileged-CI runner runs as root) holds CAP_SETGID in
     * the parent userns and writes gid_map WITHOUT needing "deny". So write
     * "deny" only when we actually lack that capability — i.e. when non-root.
     * This keeps setgroups available for the phase-3 supplementary-group drop
     * while still letting an unprivileged user map its gid. */
    char map[64];
    if (ruid != 0)
        xwrite_file("/proc/self/setgroups", "deny");
    snprintf(map, sizeof(map), "0 %d 1", (int)ruid);
    xwrite_file("/proc/self/uid_map", map);
    snprintf(map, sizeof(map), "0 %d 1", (int)rgid);
    xwrite_file("/proc/self/gid_map", map);

    /* Keep the fd open for the child; close-on-exec is fine because we
     * never exec the helper again. */
    *outNetnsFd = netnsFd;

    /* Make / mount propagation private so our binds never leak to the host. */
    xmount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL);

    /* Bind the verified runtime root onto itself and remount read-only.
     * This pins the exact tree verifyRuntimeArtifact() validated.
     *
     * The bind is MS_REC (replicate any submounts); the remount is NOT.
     * MS_REC is a no-op for remount in the upstream kernel — remount_ro()
     * applies the new flags to the top mount only and never recurses. But
     * some distro kernels (the privileged-CI runner) carry an out-of-tree
     * mount-flag validator that rejects the MS_REMOUNT|MS_BIND|MS_REC
     * combination outright (EPERM on 0x5021) even when the tree has no
     * submounts. Dropping the meaningless MS_REC is behavior-preserving on
     * mainline and required on such kernels: the verified root itself stays
     * read-only, and no submounts exist beneath it at this point (the
     * rootfs /proc is mounted later, after chroot). */
    xmount(spec->root, spec->root, NULL, MS_BIND | MS_REC, NULL);
    xmount(spec->root, spec->root, NULL,
           MS_BIND | MS_REMOUNT | MS_RDONLY, NULL);

    /* Bind each declared host mount (nosuid,nodev on the bind), then remount
     * read-only. The skill bind additionally gets noexec unless the execution
     * strategy requires native modules; run-spec.ts already encodes that
     * decision in the bind list, so the helper applies the conservative default
     * (nosuid,nodev) uniformly and adds noexec to the skill mount. */
    for (int i = 0; i < spec->hostBindsLen; i++) {
        const HostBind *b = &spec->hostBinds[i];
        /* nosuid,nodev go on the INITIAL bind, not the remount: once a bind is
         * remounted read-only the kernel ignores per-mount flag changes (and
         * the privileged-CI runner's out-of-tree mount validator rejects the
         * MS_REMOUNT|MS_BIND|MS_NOSUID|MS_NODEV combination outright, EPERM on
         * 0x1021). Setting them on the bind itself is what the kernel honors
         * and is equally restrictive. */
        unsigned long flags = MS_BIND | MS_NOSUID | MS_NODEV | (b->recursive ? MS_REC : 0);
        xmount(b->source, b->target, NULL, flags, NULL);

        /* Remount: read-only only. MS_REC is a no-op for remount (remount_ro
         * never recurses) and trips the same validator, so it is dropped here
         * too. nosuid/nodev/noexec were already applied by the bind above. */
        unsigned long remountFlags = MS_BIND | MS_REMOUNT | MS_RDONLY;
        int isSkill = (strstr(b->target, "/skill") != NULL);
        int isCa = (strstr(b->target, "/etc/skill-ca/") != NULL);
        if (isSkill && !isCa) remountFlags |= MS_NOEXEC;
        xmount(b->source, b->target, NULL, remountFlags, NULL);
    }
}

/* ------------------------------------------------------------------ */
/* Phase 2 — still outside chroot                                      */
/* ------------------------------------------------------------------ */

/* Bind a host device node (e.g. /dev/null) into the private /dev tmpfs.
 *
 * We deliberately do NOT mknod the node: the privileged-CI runner's kernel
 * hardening denies mknod() inside an unprivileged user namespace outright
 * (EPERM) even though the caller is root-in-userns with CAP_MKNOD, the target
 * is a fresh tmpfs mounted WITHOUT MS_NODEV, and no device cgroup is attached
 * (probed on the lane: `(no v1 devices.allow)`, `(no v2 devices.list)`, mknod
 * still EPERMs). Bind-mounting the host's EXISTING node needs no CAP_MKNOD and
 * is not subject to that restriction — this is the same technique bubblewrap
 * uses (bind /dev/null etc. rather than recreating them).
 *
 * A bind mounts onto an existing path, so we first create an empty regular
 * placeholder file, then bind the host device node over it. The mount is
 * read-write and NOT nosuid/nodev — these ARE the devices the sandbox is meant
 * to expose. The private /dev tmpfs superblock already carries nosuid. */
static void bind_host_device(const char *hostPath, const char *destPath) {
    int fd = open(destPath, O_WRONLY | O_CREAT | O_EXCL, 0666);
    if (fd < 0 && errno != EEXIST) die("create device placeholder %s: %s", destPath, strerror(errno));
    if (fd >= 0 && close(fd) < 0) die_errno("close device placeholder");
    xmount(hostPath, destPath, NULL, MS_BIND, NULL);
}

static void make_symlink(const char *target, const char *linkpath) {
    if (symlink(target, linkpath) < 0 && errno != EEXIST)
        die("symlink %s -> %s: %s", linkpath, target, strerror(errno));
}

static void phase2_tmpfs_and_devices(const LaunchSpec *spec) {
    char tmpTarget[OCT_PATH_MAX_LEN];
    char devTarget[OCT_PATH_MAX_LEN];
    char sizeArg[64];

    /* Private tmpfs on <root>/tmp. The size is capped by the launcher. */
    snprintf(tmpTarget, sizeof(tmpTarget), "%s%s", spec->root, INROOT_TMP);
    snprintf(sizeArg, sizeof(sizeArg), "size=%llu,nr_inodes=4096",
             (unsigned long long)spec->tmpSizeBytes);
    xmount("tmpfs", tmpTarget, "tmpfs", MS_NOSUID | MS_NODEV, sizeArg);
    if (chmod(tmpTarget, 01777) < 0) die_errno("chmod tmp");

    /* Private tmpfs on <root>/dev with only the required device nodes. */
    snprintf(devTarget, sizeof(devTarget), "%s%s", spec->root, INROOT_DEV);
    snprintf(sizeArg, sizeof(sizeArg), "size=%llu,nr_inodes=64",
             (unsigned long long)spec->devSizeBytes);
    xmount("tmpfs", devTarget, "tmpfs", MS_NOSUID, sizeArg);
    if (chmod(devTarget, 0755) < 0) die_errno("chmod dev");

    /* Only the required device nodes. Bind the host's existing nodes rather
     * than mknod() — see bind_host_device() above. */
    char p[OCT_PATH_MAX_LEN];
    snprintf(p, sizeof(p), "%s/null", devTarget);    bind_host_device("/dev/null", p);
    snprintf(p, sizeof(p), "%s/zero", devTarget);    bind_host_device("/dev/zero", p);
    snprintf(p, sizeof(p), "%s/full", devTarget);    bind_host_device("/dev/full", p);
    snprintf(p, sizeof(p), "%s/random", devTarget);  bind_host_device("/dev/random", p);
    snprintf(p, sizeof(p), "%s/urandom", devTarget); bind_host_device("/dev/urandom", p);

    /* fd links: /dev/stdin,stdout,stderr → /proc/self/fd/{0,1,2}; /dev/fd
     * → /proc/self/fd. These point at the IN-ROOT /proc (mounted in phase 3). */
    snprintf(p, sizeof(p), "%s/stdin", devTarget);  make_symlink("/proc/self/fd/0", p);
    snprintf(p, sizeof(p), "%s/stdout", devTarget); make_symlink("/proc/self/fd/1", p);
    snprintf(p, sizeof(p), "%s/stderr", devTarget); make_symlink("/proc/self/fd/2", p);
    snprintf(p, sizeof(p), "%s/fd", devTarget);     make_symlink("/proc/self/fd", p);
}

/* ------------------------------------------------------------------ */
/* Phase 3 — enter root                                                */
/* ------------------------------------------------------------------ */

/* Verify a mount is read-only by inspecting /proc/self/mountinfo. Dies if
 * the mount is absent or not flagged ro.
 *
 * mountinfo fields (proc_pid_mountinfo(5)):
 *   (1) mnt ID  (2) parent ID  (3) major:minor  (4) root  (5) mount point
 *   (6) per-mount vfs options  (7) optional tags...  "-"  (8) fs-type
 *   (9) mount-source  (10) superblock options
 *
 * The read-only flag we assert is a PER-MOUNT vfs flag (MNT_READONLY), set by
 * the bind's ro-remount. It appears in field (6), BEFORE the "-" separator —
 * e.g. "... / rw ro,nosuid,nodev ... - ext4 /dev/root rw,...". Field (10), the
 * SUPERBLOCK options, reflects the underlying filesystem (the rw ext4 the
 * runtime root was bound FROM) and stays "rw" for a read-only bind. Reading
 * field (10) here would ALWAYS report a ro-remounted bind as writable, so we
 * parse field (6). */
static void require_mount_ro(const char *inRootPath) {
    FILE *f = fopen("/proc/self/mountinfo", "r");
    if (!f) die_errno("fopen mountinfo");
    char line[8192];
    int found = 0;
    while (fgets(line, sizeof(line), f)) {
        char *save = NULL;
        char *tok = strtok_r(line, " \n", &save);
        int field = 0;
        char mountPoint[OCT_PATH_MAX_LEN] = {0};
        char mountOpts[1024] = {0};
        while (tok) {
            field++;
            if (field == 5) snprintf(mountPoint, sizeof(mountPoint), "%s", tok);
            if (field == 6) snprintf(mountOpts, sizeof(mountOpts), "%s", tok);
            if (field >= 6) break; /* only need through field 6 */
            tok = strtok_r(NULL, " \n", &save);
        }
        if (strcmp(mountPoint, inRootPath) == 0) {
            found = 1;
            /* per-mount vfs options (field 6) must contain "ro". */
            int isRo = 0;
            char *o = mountOpts, *next;
            while ((next = strchr(o, ',')) != NULL || *o) {
                size_t len = next ? (size_t)(next - o) : strlen(o);
                if (len == 2 && o[0] == 'r' && o[1] == 'o') { isRo = 1; break; }
                if (!next) break;
                o = next + 1;
            }
            if (!isRo) {
                fclose(f);
                die("mount %s is not read-only — refusing to exec", inRootPath);
            }
        }
    }
    fclose(f);
    if (!found) die("mount %s not present in mountinfo — refusing to exec", inRootPath);
}

static void phase3_enter_root(const LaunchSpec *spec, int stopBeforeExec) {
    /* chroot into the verified root. From here on we reference ONLY the
     * in-root allowlist: /skill, /tmp, /proc, /dev, /etc/skill-ca/ca.pem,
     * and the declared runtime executable. NEVER spec->root + "/tmp". */
    if (chroot(spec->root) < 0) die_errno("chroot");
    if (chdir("/") < 0) die_errno("chdir / after chroot");

    /* Mount proc on the in-root /proc. */
    xmount("proc", INROOT_PROC, "proc", MS_NOSUID | MS_NOEXEC | MS_NODEV, NULL);

    /* Verify the runtime root and skill mounts are read-only. "/" here is
     * the chrooted view; the runtime root bind is the root mount itself. */
    require_mount_ro("/");
    require_mount_ro(INROOT_SKILL);

    /* --stop-before-exec: raise SIGSTOP so the launcher can attach this
     * PID to the session cgroup. SIGCONT resumes here. */
    if (stopBeforeExec) {
        if (raise(SIGSTOP) != 0) die_errno("raise(SIGSTOP)");
    }

    /* Lock down privileges BEFORE dropping uid. */
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) die_errno("PR_SET_NO_NEW_PRIVS");
    if (setgroups(0, NULL) < 0) die_errno("setgroups");
    if (setgid(spec->gid) < 0) die_errno("setgid");
    if (setuid(spec->uid) < 0) die_errno("setuid");

    /* chdir(cwd) — cwd is an in-root absolute path from the spec. */
    if (chdir(spec->cwd) < 0) die_errno("chdir cwd");

    /* Clear the environment, then install ONLY the allowlisted env. */
    if (clearenv() != 0) die_errno("clearenv");
    for (int i = 0; i < spec->envLen; i++) {
        if (setenv(spec->envKeys[i], spec->envVals[i], 1) != 0) die_errno("setenv");
    }

    /* Build envp for execve from the now-installed environ. */
    extern char **environ;

    /* execve(command[0], command, envp). command[0] is the declared runtime
     * executable (in-root). There is no shell, no PATH search fallback. */
    execve(spec->command[0], spec->command, environ);
    /* Only reached on failure. */
    die("execve %s: %s", spec->command[0], strerror(errno));
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

static char *read_file(const char *path, size_t *outLen) {
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) die_errno(path);
    struct stat st;
    if (fstat(fd, &st) < 0) die_errno("fstat launch spec");
    if (!S_ISREG(st.st_mode)) die("launch spec is not a regular file");
    if (st.st_size <= 0 || st.st_size > 1 << 20) die("launch spec size out of range");
    /* Refuse a group/world-readable launch spec — it carries proxy config. */
    if ((st.st_mode & 077) != 0) die("launch spec must be mode 0600");

    char *buf = malloc((size_t)st.st_size);
    if (!buf) die_errno("malloc");
    size_t off = 0;
    while (off < (size_t)st.st_size) {
        ssize_t n = read(fd, buf + off, (size_t)st.st_size - off);
        if (n < 0) die_errno("read launch spec");
        if (n == 0) break;
        off += (size_t)n;
    }
    close(fd);
    *outLen = off;
    return buf;
}

/* ------------------------------------------------------------------ */
/* Namespace capability probe (--probe-namespaces)                     */
/* ------------------------------------------------------------------ */

/* Perform ONLY the user/mount/PID/IPC/UTS namespace pivot the launcher
 * relies on, then exit 0. This lets the JS probe prove the host grants
 * namespace creation WITHOUT opening any netns, mounting anything, or
 * chrooting. On any failure it die()s non-zero so the probe reads it as
 * "capability absent" (fail-closed). It must run as root, like main(). */
static void probe_namespaces(void) {
    /* Capture the real (pre-pivot) uid/gid BEFORE unshare: inside the fresh
     * user namespace getuid()/getgid() return the overflow id (65534) because
     * no uid_map exists yet, which would build an invalid "0 65534 1" map and
     * fail the uid_map write with EPERM. */
    uid_t ruid = getuid();
    gid_t rgid = getgid();
    if (unshare(CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWIPC | CLONE_NEWUTS) < 0)
        die_errno("probe unshare(NEWUSER|NEWNS|NEWPID|NEWIPC|NEWUTS)");

    /* Mirror phase-1 mapping so the probe exercises the same privileged
     * writes the real launch needs. */
    char map[64];
    xwrite_file("/proc/self/setgroups", "deny");
    snprintf(map, sizeof(map), "0 %d 1", (int)ruid);
    xwrite_file("/proc/self/uid_map", map);
    snprintf(map, sizeof(map), "0 %d 1", (int)rgid);
    xwrite_file("/proc/self/gid_map", map);

    /* Success: namespaces created and uid/gid mapped. Exit 0. The kernel
     * reclaims the (never-entered-by-a-child) namespaces on process exit. */
    _exit(0);
}

int main(int argc, char **argv) {
    const char *launchSpecPath = NULL;
    int stopBeforeExec = 0;
    int probeNs = 0;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--launch-spec") == 0 && i + 1 < argc) {
            launchSpecPath = argv[++i];
        } else if (strcmp(argv[i], "--stop-before-exec") == 0) {
            stopBeforeExec = 1;
        } else if (strcmp(argv[i], "--probe-namespaces") == 0) {
            probeNs = 1;
        } else {
            die("unknown argument: %s", argv[i]);
        }
    }

    /* The helper must run as root (real uid 0) so it can write uid_map and
     * perform the mounts. The launcher guarantees this; we enforce it. */
    if (getuid() != 0) die("os-helper must run as root");

    /* Early probe path: no launch spec required, no netns/mount/chroot. */
    if (probeNs) {
        if (launchSpecPath) die("--probe-namespaces takes no --launch-spec");
        probe_namespaces();
        /* never returns */
    }

    if (!launchSpecPath) die("missing --launch-spec <path>");

    size_t specLen = 0;
    char *specJson = read_file(launchSpecPath, &specLen);

    LaunchSpec spec;
    parse_launch_spec(specJson, specLen, &spec);

    int netnsFd = -1;

    /* Phase 1 — outside chroot. */
    phase1_outside_chroot(&spec, &netnsFd);

    /* Phase 2 — still outside chroot: tmpfs + device nodes, then fork so the
     * untrusted process is PID 1 in the new PID namespace. */
    phase2_tmpfs_and_devices(&spec);

    pid_t child = fork();
    if (child < 0) die_errno("fork");

    if (child == 0) {
        /* Child: PID 1 in the new PID namespace. Close the netns fd — phase 3
         * never touches it. */
        close(netnsFd);
        phase3_enter_root(&spec, stopBeforeExec);
        /* never returns */
        _exit(127);
    }

    /* Parent: trusted launcher. Wait for the child; propagate its exit code.
     * The cgroup kill is the security boundary; this wait only reaps. */
    int status = 0;
    pid_t w;
    do {
        w = waitpid(child, &status, 0);
    } while (w < 0 && errno == EINTR);
    if (w < 0) die_errno("waitpid");

    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    return 127;
}
