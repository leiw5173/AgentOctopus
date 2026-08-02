/*
 * vm-helper.c -- trusted host subprocess that drives the libkrun v1.19.4
 * pinned start sequence for the AgentOctopus VM sandbox backend
 * (Task 11). Part of the Trusted Computing Base.
 *
 * Built by scripts/build-vm-helper.mjs against the vendored
 * include/libkrun.h v1.19.4 header. Linked against libkrun/libkrunfw
 * when their dylibs are present under prebuilds/<platform-arch>/; until
 * Task 15 vendors those dylibs the build script performs a compile-only
 * smoke (cc -c) against this file + the header to prove the source
 * typechecks -- it does NOT leave a half-linked fake "helper" binary.
 *
 * This file is freestanding-ish C: it does not invoke a shell, does not
 * dlopen() anything, and reads configuration ONLY from a single
 * base64url JSON argv token produced by VmEngineImpl (Task 13). Every
 * krun_* return code is checked; any non-zero is fatal. There is no
 * recovery path and no partial-launch state.
 *
 * Invocation (argument array, never shell):
 *   sandbox-vm-helper --has-blk           (exit 0 if BLK support present, 1 otherwise)
 *   sandbox-vm-helper <base64url-json-launch-spec>
 *
 * where the decoded JSON (Task 13 engine produces this exact shape) is:
 *   {
 *     "rootfsPath":       "<host abs path to verified rootfs raw image>",
 *     "skillBlockPath":   "<host abs path to sealed skill block image>",
 *     "caBlockPath":      "<host abs path to sealed CA block image>",
 *     "vsockPort":        1234,
 *     "vsockHostSocket":  "<host abs path to the vsock bridge unix socket>",
 *     "cpus":             1,
 *     "memMib":           512,
 *     "bootstrapPath":    "/usr/libexec/octopus-vm-init",
 *     "bootstrapArgv":    ["<launchSpecBlob>"],
 *     "trustedEnv":       ["KEY=val", ...]
 *   }
 *
 * The helper does NOT interpret bootstrapArgv[0] (the launchSpecBlob) --
 * that is the single authoritative workload representation, opaque to the
 * host, decoded only by the guest bootstrap (Task 12). libkrun's
 * krun_set_exec uses bootstrapPath (exec_path) as the guest's argv[0] and
 * appends bootstrapArgv AFTER it, so the array carries ONLY the blob. The
 * helper asserts bootstrapArgv.length === 1 and bootstrapArgv[0] !==
 * bootstrapPath (R7 P1-3) and passes it verbatim to krun_set_exec — yielding
 * guest argv = [bootstrapPath, blob], so vm-init reads the blob at argv[1].
 *
 * Control pipe FD plumbing (R9/R10): the helper is spawned by
 * VmEngineImpl via posix_spawn with file actions that dup2 the VMM-side
 * pipe ends into FIXED FDs -- fd 3 = h2gRead (guest input), fd 4 =
 * g2hWrite (guest output). The helper hands those exact ints to
 * krun_add_console_port_inout(ctx, console_id, "octopus-control", 3, 4).
 * Immediately on main() entry the helper mass-closes every fd >= 5
 * (R10 P1-2) so nothing besides 0/1/2 (stdio) + 3/4 (control) survives
 * into the VM.
 *
 * Pinned start sequence (spec (section)Pinned TSI-disable start sequence, EXACT
 * ORDER verified against include/libkrun.h v1.19.4):
 *   1. krun_create_ctx()                                -> ctx_id
 *   2. krun_disable_implicit_vsock(ctx)
 *   3. krun_add_vsock(ctx, tsi_features=0)               -- TSI hijack DISABLED
 *   4. krun_add_vsock_port(ctx, vsockPort, vsockHostSocket)
 *      (NO virtio-net, NO passt, NO gvproxy -- no net device at all)
 *   5. krun_add_disk(ctx, "vda", rootfsPath,   true)    -- read-only raw
 *   6. krun_add_disk(ctx, "vdb", skillBlockPath,true)
 *   7. krun_add_disk(ctx, "vdc", caBlockPath,  true)
 *   8. krun_set_root_disk_remount(ctx, "/dev/vda", "ext4", "ro")
 *      (first param is the GUEST device path "/dev/vda", NOT block id "vda")
 *   9. krun_set_vm_config(ctx, cpus, memMib)            -- vCPUs BEFORE RAM
 *  10. krun_add_virtio_console_multiport(ctx)           -> console_id (>=0)
 *      krun_add_console_port_inout(ctx, console_id, "octopus-control", 3, 4)
 *  10b. krun_add_console_port_inout(ctx, console_id, "krun-stdio", 0, 1) --
 *       ONE bidirectional workload-stdio port (real fds both directions).
 *       Neither krun_add_virtio_console_default (a 2nd console device) nor
 *       multiple /dev/null-backed ports work: both panic libkrun device.rs:263
 *       "port rx queue should exist" when the guest opens the port. vm-init
 *       (guest PID 1) opens "krun-stdio" and dup2's it onto fd 0/1/2 before
 *       execve (libkrun's own init never runs).
 *  11. krun_set_exec(ctx, bootstrapPath, bootstrapArgv, trustedEnv)
 *  12. krun_set_workdir(ctx, "/")                       -- pinned to "/"
 *  13. krun_start_enter(ctx)                            -- blocks; exits with
 *                                                          guest exit code
 *
 * krun_start_enter() only returns on a pre-start configuration error
 * (returns -EINVAL); otherwise it exit()s the helper process with the
 * guest's exit code (per the v1.19.4 docstring). The helper subprocess
 * exit status IS the authoritative workload exit status (R6 P1-3).
 *
 * Fail-closed: every krun_* non-zero return and every malformed-input
 * check writes a single-line diagnostic to fd 2 and _exit()s non-zero
 * BEFORE any krun_* call that could start the VM (ctx creation is the
 * only krun_* call permitted before validation completes).
 *
 * Build: cc -I include -O2 -o sandbox-vm-helper src/vm-helper.c \
 *          -L prebuilds/<platform-arch> -lkrun -lkrunfw
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/resource.h>
#include <unistd.h>

#ifdef __linux__
#include <linux/close_range.h>  /* close_range */
#endif

#include "libkrun.h"            /* vendored v1.19.4 pin */

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

#define OCT_MAX_ARGV         16
#define OCT_MAX_ENV          128
#define OCT_PATH_MAX_LEN   4096
#define OCT_SPEC_MAX_BYTES (1u << 20)   /* 1 MiB cap on the decoded launch spec */

/* Fixed control-pipe FDs installed by VmEngineImpl's posix_spawn file
 * actions. fd 3 = h2gRead (guest input), fd 4 = g2hWrite (guest output). */
#define H2G_READ_FD   3
#define G2H_WRITE_FD  4

/* Fixed fd slot the engine inherits the PINNED, verified rootfs image at
 * (the launch spec references it as /dev/fd/5). Launch mode MUST preserve it
 * across mass_close_fds() or krun_add_disk() gets a dead path. */
#define ROOTFS_INHERIT_FD 5

/* Stdio+control FDs preserved by mass_close_fds() in BLK-probe mode (fds
 * 0-4; there is no inherited rootfs fd on the --has-blk path). */
#define FD_LOW_WATERMARK 5
/* Launch mode preserves the rootfs fd too (fds 0-5). */
#define FD_LOW_WATERMARK_LAUNCH (ROOTFS_INHERIT_FD + 1)

/* Defensive cap for fallback close loops so a huge/INFINITY rlim_cur
 * cannot cause millions of EBADF close() iterations. */
#define FD_CEILING_MAX (1 << 20)

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
        (void)!write(STDERR_FILENO, "sandbox-vm-helper: ", 19);
        (void)!write(STDERR_FILENO, buf, (size_t)n < sizeof(buf) ? (size_t)n : sizeof(buf));
        (void)!write(STDERR_FILENO, "\n", 1);
    }
    _exit(127);
}

static void die_errno(const char *what) {
    die("%s: %s", what, strerror(errno));
}

/* Fatal on a non-zero krun_* return. The libkrun error convention is a
 * negative errno-style value, so we render the raw int. */
static void krun_check(int32_t rc, const char *what) {
    if (rc != 0) {
        die("krun_%s failed: %d", what, (int)rc);
    }
}

/* ------------------------------------------------------------------ */
/* R10 P1-2 mass-close: close every fd >= 5 immediately after spawn   */
/* ------------------------------------------------------------------ */

/* Return the inclusive-exclusive upper bound for the fallback close
 * loops. Uses RLIMIT_NOFILE when available, otherwise _SC_OPEN_MAX,
 * capped defensively at FD_CEILING_MAX. The bound is clamped to at
 * least `lowWatermark` so the fallback loop never runs zero
 * iterations. When rlim_cur is below the old hard-coded 4096, the
 * loop closes exactly [lowWatermark, rlim_cur) -- this is the
 * intended design (bound by the real fd ceiling, not an arbitrary
 * constant). Comparisons against rlim_cur are done in the unsigned
 * rlim_t domain to avoid sign-wrap on pathological limits. */
static int fd_ceiling(int lowWatermark) {
    long max_fds;
    struct rlimit rl;

    if (getrlimit(RLIMIT_NOFILE, &rl) == 0) {
        if (rl.rlim_cur == RLIM_INFINITY || rl.rlim_cur > (rlim_t)FD_CEILING_MAX) {
            max_fds = FD_CEILING_MAX;
        } else {
            max_fds = (long)rl.rlim_cur;
        }
    } else {
        max_fds = sysconf(_SC_OPEN_MAX);
        if (max_fds < 0) {
            max_fds = FD_CEILING_MAX;
        }
    }

    if (max_fds > FD_CEILING_MAX) {
        max_fds = FD_CEILING_MAX;
    }
    if (max_fds < lowWatermark) {
        max_fds = lowWatermark;
    }
    return (int)max_fds;
}

/* Close every fd >= lowWatermark. Launch mode passes
 * FD_LOW_WATERMARK_LAUNCH (6) so the inherited pinned rootfs fd 5
 * survives for krun_add_disk("/dev/fd/5"); BLK-probe mode passes
 * FD_LOW_WATERMARK (5) — it has no rootfs fd to keep. */
static void mass_close_fds(int lowWatermark) {
#ifdef __linux__
    /* Prefer close_range (Linux 5.9+). ~0u is the inclusive upper bound. */
    if (close_range((unsigned int)lowWatermark, ~0u, 0) == 0) {
        return;
    }
    /* Fallback: ENOSYS on older kernels, or other error. Close a bounded
     * range. RLIMIT_NOFILE bounds this; cap defensively at a high int. */
    for (int fd = lowWatermark; fd < fd_ceiling(lowWatermark); fd++) {
        (void)close(fd);
    }
#else
    /* Darwin: prefer closefrom(2) when declared by the SDK; otherwise a
     * bounded close loop. closefrom is available on macOS but may be
     * gated behind SDK feature macros, so we also fall back to the loop. */
#ifdef HAVE_CLOSEFROM
    closefrom(lowWatermark);
#else
    for (int fd = lowWatermark; fd < fd_ceiling(lowWatermark); fd++) {
        (void)close(fd);
    }
#endif
#endif
}

/* ------------------------------------------------------------------ */
/* Launch-spec model (parsed from base64url-then-JSON in argv[1])      */
/* ------------------------------------------------------------------ */

typedef struct {
    char    *argv_item;     /* heap-owned */
} ArgvItem;

typedef struct {
    char    *env_item;      /* heap-owned, "KEY=val" */
} EnvItem;

typedef struct {
    char    *rootfsPath;
    char    *skillBlockPath;
    char    *caBlockPath;
    uint32_t vsockPort;
    char    *vsockHostSocket;
    uint8_t  cpus;
    uint32_t memMib;
    char    *bootstrapPath;
    char    *bootstrapArgv[OCT_MAX_ARGV];   /* pointers into decoded strings */
    int      bootstrapArgvLen;
    char    *trustedEnv[OCT_MAX_ENV];        /* pointers into decoded strings */
    int      trustedEnvLen;
} VmLaunchSpec;

/* ------------------------------------------------------------------ */
/* base64url decode (no system curl, no shell)                         */
/* ------------------------------------------------------------------ */

/* Accepts both base64url and plain base64 (the engine emits base64url);
 * tolerates a missing or present '=' padding. Rejects any byte outside
 * the alphabet. Returns malloc'd buffer (caller frees) and sets *outLen,
 * or dies on malformed input. */
static unsigned char *b64url_decode(const char *in, size_t inLen, size_t *outLen) {
    /* tab[c] = 6-bit value for valid alphabet byte; only meaningful when
     * alphabet_ok[c] is non-zero. Covers base64url ('-','_') and plain
     * base64 ('+','/') tolerantly. */
    static const int8_t tab[256] = {
        ['A']= 0,['B']= 1,['C']= 2,['D']= 3,['E']= 4,['F']= 5,['G']= 6,['H']= 7,
        ['I']= 8,['J']= 9,['K']=10,['L']=11,['M']=12,['N']=13,['O']=14,['P']=15,
        ['Q']=16,['R']=17,['S']=18,['T']=19,['U']=20,['V']=21,['W']=22,['X']=23,
        ['Y']=24,['Z']=25,
        ['a']=26,['b']=27,['c']=28,['d']=29,['e']=30,['f']=31,['g']=32,['h']=33,
        ['i']=34,['j']=35,['k']=36,['l']=37,['m']=38,['n']=39,['o']=40,['p']=41,
        ['q']=42,['r']=43,['s']=44,['t']=45,['u']=46,['v']=47,['w']=48,['x']=49,
        ['y']=50,['z']=51,
        ['0']=52,['1']=53,['2']=54,['3']=55,['4']=56,['5']=57,['6']=58,['7']=59,
        ['8']=60,['9']=61,
        ['-']=62,['_']=63,                /* base64url */
        ['+']=62,['/']=63,                /* plain base64 (tolerated) */
    };
    /* Membership table: alphabet_ok[c] is non-zero iff c is a valid
     * base64/base64url alphabet byte. Disambiguates 'A' (value 0) from
     * the uninitialized zero slots in `tab`. */
    static const unsigned char alphabet_ok[256] = {
        ['A']=1,['B']=1,['C']=1,['D']=1,['E']=1,['F']=1,['G']=1,['H']=1,
        ['I']=1,['J']=1,['K']=1,['L']=1,['M']=1,['N']=1,['O']=1,['P']=1,
        ['Q']=1,['R']=1,['S']=1,['T']=1,['U']=1,['V']=1,['W']=1,['X']=1,
        ['Y']=1,['Z']=1,
        ['a']=1,['b']=1,['c']=1,['d']=1,['e']=1,['f']=1,['g']=1,['h']=1,
        ['i']=1,['j']=1,['k']=1,['l']=1,['m']=1,['n']=1,['o']=1,['p']=1,
        ['q']=1,['r']=1,['s']=1,['t']=1,['u']=1,['v']=1,['w']=1,['x']=1,
        ['y']=1,['z']=1,
        ['0']=1,['1']=1,['2']=1,['3']=1,['4']=1,['5']=1,['6']=1,['7']=1,
        ['8']=1,['9']=1,
        ['-']=1,['_']=1,['+']=1,['/']=1,
    };

    /* Strip a single trailing run of '=' padding (0..2). */
    size_t pad = 0;
    while (inLen > 0 && in[inLen - 1] == '=') { inLen--; pad++; }
    if (pad > 2) die("launch spec: bad base64 padding");

    size_t cap = (inLen / 4) * 3 + 3;
    unsigned char *out = (unsigned char *)malloc(cap);
    if (!out) die_errno("malloc (b64 decode)");

    size_t o = 0;
    uint32_t acc = 0;
    int bits = 0;
    for (size_t i = 0; i < inLen; i++) {
        unsigned char c = (unsigned char)in[i];
        if (!alphabet_ok[c]) die("launch spec: invalid base64 byte 0x%02x", (unsigned)c);
        acc = (acc << 6) | (uint32_t)(unsigned char)tab[c];
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[o++] = (unsigned char)((acc >> bits) & 0xff);
        }
    }
    *outLen = o;
    return out;
}

/* ------------------------------------------------------------------ */
/* Minimal strict JSON scanner (mirrors os-helper/helper.c style)      */
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

static int peek(Scanner *s) { skip_ws(s); return s->cur < s->end ? (unsigned char)*s->cur : -1; }

static void expect(Scanner *s, char c) {
    skip_ws(s);
    if (s->cur >= s->end || *s->cur != c)
        die("launch spec parse error: expected '%c'", c);
    s->cur++;
}

/* Parse a JSON string into a freshly malloc'd, NUL-terminated buffer.
 * Rejects any embedded NUL (parsed strings become C strings -- argv, env,
 * paths -- where an embedded NUL silently truncates). Handles the escapes
 * JSON.stringify can produce. Returns the malloc'd string (caller frees). */
static char *parse_string_dup(Scanner *s) {
    expect(s, '"');
    size_t cap = 128, n = 0;
    char *out = (char *)malloc(cap);
    if (!out) die_errno("malloc (json string)");
    while (s->cur < s->end && *s->cur != '"') {
        char c = *s->cur++;
        if (c == '\0') die("launch spec: NUL byte in string");
        if ((unsigned char)c < 0x20) die("launch spec: raw control char in string");
        if (c == '\\') {
            if (s->cur >= s->end) die("launch spec: dangling escape");
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
                    if (s->end - s->cur < 4) die("launch spec: short \\u escape");
                    unsigned v = 0;
                    for (int i = 0; i < 4; i++) {
                        char h = *s->cur++;
                        v <<= 4;
                        if (h >= '0' && h <= '9') v |= (unsigned)(h - '0');
                        else if (h >= 'a' && h <= 'f') v |= (unsigned)(h - 'a' + 10);
                        else if (h >= 'A' && h <= 'F') v |= (unsigned)(h - 'A' + 10);
                        else die("launch spec: bad \\u escape");
                    }
                    if (v == 0) die("launch spec: \\u0000 (NUL) is never legitimate in a string");
                    if (v > 0x7f) die("launch spec: non-ASCII \\u escape not supported");
                    if (v < 0x20) die("launch spec: control char in \\u escape");
                    c = (char)v;
                    break;
                }
                default:
                    die("launch spec: unknown escape '\\%c'", e);
            }
        }
        if (n + 1 >= cap) {
            cap *= 2;
            char *p = (char *)realloc(out, cap);
            if (!p) die_errno("realloc (json string)");
            out = p;
        }
        out[n++] = c;
    }
    if (s->cur >= s->end) die("launch spec: unterminated string");
    s->cur++; /* closing quote */
    out[n] = '\0';
    return out;
}

/* Parse an unsigned integer. Dies on non-digit. */
static uint64_t parse_u64(Scanner *s) {
    skip_ws(s);
    if (s->cur >= s->end || *s->cur < '0' || *s->cur > '9')
        die("launch spec: expected unsigned number");
    uint64_t v = 0;
    while (s->cur < s->end && *s->cur >= '0' && *s->cur <= '9') {
        uint64_t nv = v * 10 + (uint64_t)(*s->cur - '0');
        if (nv < v) die("launch spec: u64 overflow");
        v = nv;
        s->cur++;
    }
    return v;
}

static void skip_value(Scanner *s);

static void skip_object(Scanner *s) {
    expect(s, '{');
    if (peek(s) == '}') { s->cur++; return; }
    for (;;) {
        char *k = parse_string_dup(s);
        free(k);
        expect(s, ':');
        skip_value(s);
        int c = peek(s);
        if (c == ',') { s->cur++; continue; }
        if (c == '}') { s->cur++; return; }
        die("launch spec: expected ',' or '}' in object");
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
        die("launch spec: expected ',' or ']' in array");
    }
}

static void skip_value(Scanner *s) {
    int c = peek(s);
    if (c == '{') { skip_object(s); return; }
    if (c == '[') { skip_array(s); return; }
    if (c == '"') { char *t = parse_string_dup(s); free(t); return; }
    if (c == 't' || c == 'f') {
        if (s->end - s->cur >= 4 && memcmp(s->cur, "true", 4) == 0) { s->cur += 4; return; }
        if (s->end - s->cur >= 5 && memcmp(s->cur, "false", 5) == 0) { s->cur += 5; return; }
        die("launch spec: bad boolean");
    }
    if (c == 'n') {
        if (s->end - s->cur >= 4 && memcmp(s->cur, "null", 4) == 0) { s->cur += 4; return; }
        die("launch spec: bad null");
    }
    if (c == '-' || (c >= '0' && c <= '9')) {
        s->cur++;
        while (s->cur < s->end && (strchr("0123456789+-.eE", *s->cur) != NULL)) s->cur++;
        return;
    }
    die("launch spec: unexpected value");
}

/* Parse the bootstrapArgv JSON array into spec->bootstrapArgv[]. */
static void parse_bootstrap_argv(Scanner *s, VmLaunchSpec *out) {
    expect(s, '[');
    if (peek(s) == ']') die("launch spec: bootstrapArgv must not be empty");
    for (;;) {
        if (out->bootstrapArgvLen >= OCT_MAX_ARGV) die("launch spec: too many bootstrapArgv entries");
        out->bootstrapArgv[out->bootstrapArgvLen++] = parse_string_dup(s);
        int c = peek(s);
        if (c == ',') { s->cur++; continue; }
        if (c == ']') { s->cur++; break; }
        die("launch spec: expected ',' or ']' in bootstrapArgv");
    }
}

/* Parse the trustedEnv JSON array into spec->trustedEnv[]. */
static void parse_trusted_env(Scanner *s, VmLaunchSpec *out) {
    expect(s, '[');
    if (peek(s) == ']') { s->cur++; return; }
    for (;;) {
        if (out->trustedEnvLen >= OCT_MAX_ENV) die("launch spec: too many trustedEnv entries");
        char *e = parse_string_dup(s);
        /* env entries must be "KEY=value" with a non-empty KEY. */
        char *eq = strchr(e, '=');
        if (eq == NULL || eq == e) die("launch spec: trustedEnv entry missing 'KEY=' prefix");
        out->trustedEnv[out->trustedEnvLen++] = e;
        int c = peek(s);
        if (c == ',') { s->cur++; continue; }
        if (c == ']') { s->cur++; break; }
        die("launch spec: expected ',' or ']' in trustedEnv");
    }
}

static void parse_launch_spec(const char *json, size_t len, VmLaunchSpec *out) {
    Scanner s = { .cur = json, .end = json + len };
    memset(out, 0, sizeof(*out));

    int haveRootfs = 0, haveSkill = 0, haveCa = 0, havePort = 0, haveSock = 0;
    int haveCpus = 0, haveMem = 0, haveBsPath = 0, haveBsArgv = 0, haveEnv = 0;

    expect(&s, '{');
    if (peek(&s) == '}') { s.cur++; die("launch spec: empty object"); }
    for (;;) {
        char *key = parse_string_dup(&s);
        expect(&s, ':');
        if (strcmp(key, "rootfsPath") == 0) {
            out->rootfsPath = parse_string_dup(&s); haveRootfs = 1;
        } else if (strcmp(key, "skillBlockPath") == 0) {
            out->skillBlockPath = parse_string_dup(&s); haveSkill = 1;
        } else if (strcmp(key, "caBlockPath") == 0) {
            out->caBlockPath = parse_string_dup(&s); haveCa = 1;
        } else if (strcmp(key, "vsockPort") == 0) {
            uint64_t p = parse_u64(&s);
            if (p == 0 || p > 0xffffffffu) die("launch spec: vsockPort out of range");
            out->vsockPort = (uint32_t)p; havePort = 1;
        } else if (strcmp(key, "vsockHostSocket") == 0) {
            out->vsockHostSocket = parse_string_dup(&s); haveSock = 1;
        } else if (strcmp(key, "cpus") == 0) {
            uint64_t c = parse_u64(&s);
            if (c == 0 || c > 0xffu) die("launch spec: cpus out of range");
            out->cpus = (uint8_t)c; haveCpus = 1;
        } else if (strcmp(key, "memMib") == 0) {
            uint64_t m = parse_u64(&s);
            if (m == 0 || m > 0xffffffffu) die("launch spec: memMib out of range");
            out->memMib = (uint32_t)m; haveMem = 1;
        } else if (strcmp(key, "bootstrapPath") == 0) {
            out->bootstrapPath = parse_string_dup(&s); haveBsPath = 1;
        } else if (strcmp(key, "bootstrapArgv") == 0) {
            parse_bootstrap_argv(&s, out); haveBsArgv = 1;
        } else if (strcmp(key, "trustedEnv") == 0) {
            parse_trusted_env(&s, out); haveEnv = 1;
        } else {
            skip_value(&s);
        }
        free(key);
        int c = peek(&s);
        if (c == ',') { s.cur++; continue; }
        if (c == '}') { s.cur++; break; }
        die("launch spec: expected ',' or '}' at top level");
    }
    skip_ws(&s);
    if (s.cur != s.end) die("launch spec: trailing garbage after top-level object");

    /* Required fields. */
    if (!haveRootfs)   die("launch spec: missing rootfsPath");
    if (!haveSkill)    die("launch spec: missing skillBlockPath");
    if (!haveCa)       die("launch spec: missing caBlockPath");
    if (!havePort)     die("launch spec: missing vsockPort");
    if (!haveSock)     die("launch spec: missing vsockHostSocket");
    if (!haveCpus)     die("launch spec: missing cpus");
    if (!haveMem)      die("launch spec: missing memMib");
    if (!haveBsPath)   die("launch spec: missing bootstrapPath");
    if (!haveBsArgv)   die("launch spec: missing bootstrapArgv");
    /* trustedEnv is optional on the wire; default to empty. */
    (void)haveEnv;

    /* Structural validation BEFORE any krun_* call. */
    if (out->rootfsPath[0]      != '/') die("launch spec: rootfsPath must be absolute");
    if (out->skillBlockPath[0]  != '/') die("launch spec: skillBlockPath must be absolute");
    if (out->caBlockPath[0]     != '/') die("launch spec: caBlockPath must be absolute");
    if (out->vsockHostSocket[0] != '/') die("launch spec: vsockHostSocket must be absolute");
    if (out->bootstrapPath[0]   != '/') die("launch spec: bootstrapPath must be absolute");
    if (strstr(out->rootfsPath,      "..")) die("launch spec: rootfsPath must not contain '..'");
    if (strstr(out->skillBlockPath,  "..")) die("launch spec: skillBlockPath must not contain '..'");
    if (strstr(out->caBlockPath,     "..")) die("launch spec: caBlockPath must not contain '..'");
    if (strstr(out->vsockHostSocket, "..")) die("launch spec: vsockHostSocket must not contain '..'");
    if (strstr(out->bootstrapPath,   "..")) die("launch spec: bootstrapPath must not contain '..'");

    /* R7 P1-3: bootstrapArgv is the SINGLE authoritative workload
     * representation. libkrun's krun_set_exec uses bootstrapPath (exec_path)
     * as the guest's argv[0] and appends bootstrapArgv AFTER it, so the array
     * carries ONLY the launch-spec blob — exactly 1 entry, and it must NOT
     * repeat bootstrapPath (that would push the blob to argv[2] and make
     * vm-init read the path at argv[1] -> "decode/validate failed"). */
    if (out->bootstrapArgvLen != 1)
        die("launch spec: bootstrapArgv must have exactly 1 entry (the launchSpecBlob)");
    if (strcmp(out->bootstrapArgv[0], out->bootstrapPath) == 0)
        die("launch spec: bootstrapArgv must not repeat bootstrapPath (libkrun supplies argv[0])");
    if (out->bootstrapArgv[0][0] == '\0')
        die("launch spec: bootstrapArgv[0] (launchSpecBlob) must not be empty");

    /* Verify the fixed control FDs are actually open (the engine dup2'd
     * them into 3/4). If they aren't, krun would get EBADF later; fail
     * early with a clear message instead. */
    if (fcntl(H2G_READ_FD, F_GETFD) < 0)
        die("control fd %d (h2gRead) not open -- engine did not dup2 it", H2G_READ_FD);
    if (fcntl(G2H_WRITE_FD, F_GETFD) < 0)
        die("control fd %d (g2hWrite) not open -- engine did not dup2 it", G2H_WRITE_FD);
    /* The engine inherits the PINNED verified rootfs image at fd 5 and the
     * launch spec references it as /dev/fd/5 — verify it survived the
     * mass-close (and the engine's dup2) before krun_add_disk would get a
     * dead path. */
    if (fcntl(ROOTFS_INHERIT_FD, F_GETFD) < 0)
        die("rootfs fd %d not open -- engine did not dup2 it (or mass-close dropped it)",
            ROOTFS_INHERIT_FD);
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

int vm_helper_main(int argc, char **argv);

int main(int argc, char **argv) {
    return vm_helper_main(argc, argv);
}
int vm_helper_main(int argc, char **argv) {
    /* Decide the mode BEFORE mass-closing: the BLK probe has no inherited
     * rootfs fd, so it may close everything >= FD_LOW_WATERMARK (5); launch
     * mode must preserve the pinned rootfs fd 5 that the launch spec
     * references as /dev/fd/5, so its watermark is 6. */
    const int isBlkProbe = (argc >= 2 && strcmp(argv[1], "--has-blk") == 0);
    mass_close_fds(isBlkProbe ? FD_LOW_WATERMARK : FD_LOW_WATERMARK_LAUNCH);

    /* Early-return subcommand: probe whether the linked libkrun was built
     * with block-device (BLK) support. The engine uses this to fail-closed
     * when KRUN_FEATURE_BLK is unavailable. This path MUST NOT parse argv[1]
     * as a launch spec. */
    if (isBlkProbe) {
        return krun_has_feature(KRUN_FEATURE_BLK) ? 0 : 1;
    }

    if (argc != 2) {
        die("usage: sandbox-vm-helper <base64url-json-launch-spec>");
    }

    const char *token = argv[1];
    size_t tokenLen = strlen(token);
    if (tokenLen == 0) die("launch spec: empty argv[1]");
    if (tokenLen > OCT_SPEC_MAX_BYTES) die("launch spec: argv[1] too large");

    /* Decode base64url -> JSON bytes. */
    size_t jsonLen = 0;
    unsigned char *json = b64url_decode(token, tokenLen, &jsonLen);
    if (jsonLen == 0) die("launch spec: decoded payload is empty");
    /* The JSON scanner is NUL-free in source for the shapes we parse, but
     * defend against an embedded NUL that would silently terminate. */
    if (memchr(json, '\0', jsonLen) != NULL) die("launch spec: NUL byte in decoded JSON");

    VmLaunchSpec spec;
    parse_launch_spec((const char *)json, jsonLen, &spec);
    /* json + spec fields share heap ownership from here; freed at exit. */
    (void)json;

    /* krun_create_ctx is permitted before the VM starts; all subsequent
     * krun_* calls run the pinned sequence. */
    int32_t ctx = krun_create_ctx();
    if (ctx < 0) die("krun_create_ctx failed: %d", (int)ctx);

    /* DIAGNOSTIC: when OCT_VM_HELPER_KRUN_DEBUG=1, raise libkrun's internal
     * log level to Trace so krun_start_enter's EINVAL surfaces its actual
     * cause (which config element libkrun rejects, incl. the HVF VmCreate
     * syscall result). Off by default so the production helper stays silent;
     * the CI gate sets it to diagnose boot failures. Logging goes to stderr,
     * which the gate captures. */
    if (getenv("OCT_VM_HELPER_KRUN_DEBUG") != NULL)
        (void)krun_set_log_level(KRUN_LOG_LEVEL_TRACE);

    /* 1. Disable the implicit vsock device so none are injected. */
    krun_check(krun_disable_implicit_vsock((uint32_t)ctx), "disable_implicit_vsock");

    /* 2. Add ONE vsock with tsi_features = 0 (no INET/UNIX hijack). */
    krun_check(krun_add_vsock((uint32_t)ctx, /*tsi_features=*/ 0), "add_vsock");

    /* 3. Register the single allowed vsock port -> host unix socket. */
    krun_check(krun_add_vsock_port((uint32_t)ctx, spec.vsockPort, spec.vsockHostSocket),
               "add_vsock_port");

    /* 4. NO virtio-net / passt / gvproxy. Combined with steps 1-2, TSI has
     *    nothing to hijack onto. */

    /* 5-7. Attach the three read-only raw block devices. */
    krun_check(krun_add_disk((uint32_t)ctx, "vda", spec.rootfsPath,     /*read_only=*/ true), "add_disk(vda)");
    krun_check(krun_add_disk((uint32_t)ctx, "vdb", spec.skillBlockPath, /*read_only=*/ true), "add_disk(vdb)");
    krun_check(krun_add_disk((uint32_t)ctx, "vdc", spec.caBlockPath,    /*read_only=*/ true), "add_disk(vdc)");

    /* 8. Promote the rootfs disk to the root mount. First param is the
     *    GUEST device path "/dev/vda" (NOT the block id "vda"). */
    krun_check(krun_set_root_disk_remount((uint32_t)ctx, "/dev/vda", "ext4", "ro"),
               "set_root_disk_remount");

    /* 9. VM config: vCPUs BEFORE RAM (v1.19.4 signature). */
    krun_check(krun_set_vm_config((uint32_t)ctx, spec.cpus, spec.memMib), "set_vm_config");

    /* 10. Control port: multiport console, then register the
     *     "octopus-control" port on fd 3 (input) / fd 4 (output). */
    int32_t console_id = krun_add_virtio_console_multiport((uint32_t)ctx);
    if (console_id < 0) die("krun_add_virtio_console_multiport failed: %d", (int)console_id);
    krun_check(krun_add_console_port_inout((uint32_t)ctx, (uint32_t)console_id,
                                           "octopus-control",
                                           /*input_fd=*/ H2G_READ_FD,
                                           /*output_fd=*/ G2H_WRITE_FD),
               "add_console_port_inout");

    /* 10b. Workload stdio as ONE named bidirectional port on the SAME multiport
     *      console (NOT a second console device, and NOT multiple ports).
     *      Two libkrun constraints force the single-port design:
     *        (a) krun_add_virtio_console_default adds a second console device
     *            whose ports panic libkrun (device.rs:263 "port rx queue should
     *            exist") the moment the guest opens them; and
     *        (b) on this one console, a port whose input_fd is /dev/null -- or
     *            any port beyond the first data port -- also trips that same
     *            panic (observed: guest opens port 2 -> SIGABRT 134).
     *      So register exactly ONE extra port, "krun-stdio", with REAL fds on
     *      both directions (helper stdin -> guest, guest -> helper stdout).
     *      vm-init (guest PID 1 -- NOT libkrun's init) opens it by name and
     *      dup2's it onto the workload's fd 0/1/2 before execve, giving a
     *      serial-style bidirectional stdio channel to the host. It stays
     *      separate from octopus-control, which keeps the ready/error frames. */
    krun_check(krun_add_console_port_inout((uint32_t)ctx, (uint32_t)console_id,
                                           "krun-stdio",
                                           /*input_fd=*/ STDIN_FILENO,
                                           /*output_fd=*/ STDOUT_FILENO),
               "add krun-stdio port");

    /* 11. Set the guest PID 1 to the trusted bootstrap. bootstrapArgv is
     *     the single authoritative workload representation; trustedEnv is
     *     the constructed environment (proxy/CA vars + LaunchSpec.env). */
    /* libkrun wants NULL-terminated argv/envp arrays. */
    char *argv_term[OCT_MAX_ARGV + 1];
    if (spec.bootstrapArgvLen + 1 > (int)(sizeof(argv_term) / sizeof(argv_term[0])))
        die("internal: bootstrapArgv overflow");
    for (int i = 0; i < spec.bootstrapArgvLen; i++) argv_term[i] = spec.bootstrapArgv[i];
    argv_term[spec.bootstrapArgvLen] = NULL;

    char *env_term[OCT_MAX_ENV + 1];
    if (spec.trustedEnvLen + 1 > (int)(sizeof(env_term) / sizeof(env_term[0])))
        die("internal: trustedEnv overflow");
    for (int i = 0; i < spec.trustedEnvLen; i++) env_term[i] = spec.trustedEnv[i];
    env_term[spec.trustedEnvLen] = NULL;

    krun_check(krun_set_exec((uint32_t)ctx, spec.bootstrapPath,
                             (const char *const *)argv_term,
                             (const char *const *)env_term),
               "set_exec");

    /* 12. workdir pinned to "/" -- the workload cwd lives under /skill,
     *     which does not exist until the bootstrap mounts /dev/vdb. */
    krun_check(krun_set_workdir((uint32_t)ctx, "/"), "set_workdir");

    /* 13. Start + enter. Only returns on a pre-start config error
     *     (-EINVAL); otherwise exit()s the helper with the guest exit
     *     code. That helper exit status IS the workload exit status. */
    int32_t rc = krun_start_enter((uint32_t)ctx);
    /* Reached only on pre-start error. */
    die("krun_start_enter returned (pre-start error): %d", (int)rc);

    /* Unreachable. */
    return 127;
}
