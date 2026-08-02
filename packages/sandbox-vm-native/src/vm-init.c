/*
 * vm-init.c -- octopus-vm-init, the trusted guest PID 1 for the
 * AgentOctopus VM sandbox backend (Task 12). Part of the Trusted
 * Computing Base.
 *
 * krun_set_exec launches this as guest PID 1 with:
 *   argv[0] = "/usr/libexec/octopus-vm-init"
 *   argv[1] = <base64url(canonical-CBOR(LaunchSpec))>
 *
 * The workload executable/argv/env travel ONLY as that structured token
 * (NOT a shell string, NOT over the control channel). The control channel
 * (virtio-console port "octopus-control") carries ONLY {"ready":true} and
 * {"error":"<reason>"} frames; workload stdio rides a SECOND named port on
 * the same multiport device, "krun-stdio", which the host helper wires to
 * its stdout/stdin pipes (guest write -> host raw.stdout; host raw.stdin ->
 * guest read). vm-init opens the "krun-stdio" port by name (via
 * /sys/class/virtio-ports) and dup2's it onto fd 0/1/2 before execve.
 * Workload exit status is the krun_start_enter return
 * value read by the host helper subprocess -- this process execve's into
 * the workload and never returns to send an exit frame.
 *
 * Bootstrap protocol (spec §R4 P1-3 / R6 trusted bootstrap, exact order):
 *   1. mount -o ro /dev/vdb /skill
 *   2. mount -o ro /dev/vdc /etc/skill-ca
 *   3. mount -t tmpfs tmpfs /tmp + mount -t tmpfs tmpfs /run
 *   4. start loopback<->vsock forwarder (bind 127.0.0.1:<vsockPort>,
 *      relay to AF_VSOCK)
 *   5. open control port: scan /sys/class/virtio-ports/<port>/name for
 *      "octopus-control", open /dev/vportNpM r/w
 *   6. base64url-decode argv[1] -> CBOR-decode -> LaunchSpec; validate
 *      (schemaVersion==1, NUL-free strings, env regex, cwd absolute,
 *      allowedExecutables values absolute). On failure: write
 *      {"error":"<reason>"} + exit(127) WITHOUT execve.
 *   7. canonicalize cwd against /dev/vdb; MUST resolve under /skill (no
 *      .. / symlink breakout). Else {"error"} + exit(127).
 *   8. write {"ready":true} on the control port.
 *   9. resolve executable -- THREE branches: /skill/... realpath under
 *      /skill; rootfs-absolute EXACTLY matches an allowedExecutables
 *      value; bare name is a key in allowedExecutables. "other" =>
 *      {"error":"unresolvable executable"} + exit(127).
 *  10. chdir(cwd), CLOSE the control port fd, redirect fd 0/1/2 onto the
 *      "krun-stdio" named virtio-console port (workload stdio -> host via
 *      the helper's krun-stdio port pipes), execve(resolved, argv, envp).
 *
 * Freestanding-ish C: no shell, no dlopen, no PATH lookup by execve
 * (the bootstrap resolves bare names itself). Every error is fatal and
 * reported over the control port before exit(127).
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <limits.h>
#include <dirent.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <netinet/in.h>

#ifdef __linux__
#include <linux/vm_sockets.h>   /* AF_VSOCK, struct sockaddr_vm (guest-only) */
#define OCTOPUS_HAVE_VSOCK 1
#else
#define OCTOPUS_HAVE_VSOCK 0
#endif

/* ------------------------------------------------------------------ */
/* Bounds (mirror packages/sandbox launch-spec caps)                  */
/* ------------------------------------------------------------------ */

#define MAX_DECODED_BYTES   65536   /* MAX_LAUNCH_SPEC_DECODED_BYTES  */
#define MAX_ARGV_BYTES      98304   /* MAX_LAUNCH_SPEC_ARGV_BYTES     */
#define MAX_ENV_ENTRIES     1024
#define MAX_ARGV_ENTRIES    1024
#define MAX_ALLOWED_ENTRIES 256
#define MAX_STR_LEN         4096

/* ------------------------------------------------------------------ */
/* LaunchSpec model (decoded from base64url+CBOR in argv[1])           */
/* ------------------------------------------------------------------ */

typedef struct {
    char *executable;           /* may be bare name, /skill/..., or rootfs-abs */
    char **argv;                /* NULL-terminated */
    size_t argv_n;
    char *cwd;                  /* absolute */
    char **env;                 /* KEY=VALUE, NULL-terminated */
    size_t env_n;
    /* allowedExecutables: parallel arrays (bare name -> abs path) */
    char **ae_names;
    char **ae_paths;
    size_t ae_n;
} LaunchSpec;

/* ------------------------------------------------------------------ */
/* Error reporting over the control port                              */
/* ------------------------------------------------------------------ */

static int g_control_fd = -1;

static void control_write(const char *json_frame) {
    if (g_control_fd < 0) return;
    /* best-effort; ignore partial-write/EBADF -- we exit right after */
    size_t off = 0, len = strlen(json_frame);
    while (off < len) {
        ssize_t n = write(g_control_fd, json_frame + off, len - off);
        if (n <= 0) break;
        off += (size_t)n;
    }
}

static void die(const char *reason) {
    char frame[MAX_STR_LEN];
    int n = snprintf(frame, sizeof(frame), "{\"error\":\"%s\"}", reason);
    if (n < 0) n = 0;
    if ((size_t)n >= sizeof(frame)) n = sizeof(frame) - 1;
    /* truncate at frame boundary; the frame is already written above */
    (void)n;
    control_write(frame);
    _exit(127);
}

/* ------------------------------------------------------------------ */
/* base64url decode (accepts base64url and plain base64)              */
/* ------------------------------------------------------------------ */

static unsigned char *b64url_decode(const char *in, size_t inLen, size_t *outLen) {
    static const signed char alphabet_ok[256] = {
        ['A']=0,['B']=1,['C']=2,['D']=3,['E']=4,['F']=5,['G']=6,['H']=7,
        ['I']=8,['J']=9,['K']=10,['L']=11,['M']=12,['N']=13,['O']=14,
        ['P']=15,['Q']=16,['R']=17,['S']=18,['T']=19,['U']=20,['V']=21,
        ['W']=22,['X']=23,['Y']=24,['Z']=25,
        ['a']=26,['b']=27,['c']=28,['d']=29,['e']=30,['f']=31,['g']=32,
        ['h']=33,['i']=34,['j']=35,['k']=36,['l']=37,['m']=38,['n']=39,
        ['o']=40,['p']=41,['q']=42,['r']=43,['s']=44,['t']=45,['u']=46,
        ['v']=47,['w']=48,['x']=49,['y']=50,['z']=51,
        ['0']=52,['1']=53,['2']=54,['3']=55,['4']=56,['5']=57,['6']=58,
        ['7']=59,['8']=60,['9']=61,
        ['-']=62,['_']=63,                /* base64url */
        ['+']=62,['/']=63,                /* plain base64 */
    };

    if (inLen == 0) { *outLen = 0; return NULL; }
    if (inLen > MAX_DECODED_BYTES * 2) return NULL; /* bound input */

    /* strip trailing '=' padding */
    while (inLen > 0 && in[inLen - 1] == '=') inLen--;

    size_t cap = (inLen / 4) * 3 + 3;
    unsigned char *out = (unsigned char *)malloc(cap);
    if (!out) return NULL;

    size_t o = 0;
    size_t i = 0;
    while (i < inLen) {
        int v[4] = {0,0,0,0};
        int got = 0;
        for (int k = 0; k < 4 && i < inLen; k++) {
            unsigned char c = (unsigned char)in[i++];
            if (c == '=') break;
            signed int a = alphabet_ok[c];
            if (!a && c != 'A') { free(out); return NULL; } /* invalid byte */
            v[k] = a;
            got++;
        }
        if (got >= 2) out[o++] = (unsigned char)((v[0] << 2) | (v[1] >> 4));
        if (got >= 3) out[o++] = (unsigned char)((v[1] << 4) | (v[2] >> 2));
        if (got >= 4) out[o++] = (unsigned char)((v[2] << 6) | v[3]);
    }
    *outLen = o;
    return out;
}

/* ------------------------------------------------------------------ */
/* Minimal canonical-CBOR decoder for the fixed LaunchSpec shape      */
/* {schemaVersion:1, executable, argv[], cwd, env[], allowedExecutables{}} */
/* ------------------------------------------------------------------ */

typedef struct {
    const unsigned char *p;
    const unsigned char *end;
} Cbor;

static int cbor_read_byte(Cbor *c, unsigned char *out) {
    if (c->p >= c->end) return -1;
    *out = *c->p++;
    return 0;
}

/* Read the major type + additional info, return major type (0-7) or -1.
 * Fills *val with the argument. */
static int cbor_read_head(Cbor *c, uint64_t *val) {
    unsigned char ib;
    if (cbor_read_byte(c, &ib) < 0) return -1;
    int mt = ib >> 5;
    unsigned char ai = ib & 0x1f;
    if (ai < 24) { *val = ai; return mt; }
    if (ai == 24) { unsigned char b; if (cbor_read_byte(c,&b)<0) return -1; *val=b; return mt; }
    if (ai == 25) {
        unsigned char b0,b1; if (cbor_read_byte(c,&b0)<0||cbor_read_byte(c,&b1)<0) return -1;
        *val = ((uint64_t)b0 << 8) | b1; return mt;
    }
    if (ai == 26) {
        unsigned char b[4];
        for (int k=0;k<4;k++) if (cbor_read_byte(c,&b[k])<0) return -1;
        *val = ((uint64_t)b[0]<<24)|((uint64_t)b[1]<<16)|((uint64_t)b[2]<<8)|b[3]; return mt;
    }
    if (ai == 27) {
        unsigned char b[8];
        for (int k=0;k<8;k++) if (cbor_read_byte(c,&b[k])<0) return -1;
        *val=0;
        for (int k=0;k<8;k++) *val = (*val << 8) | b[k];
        return mt;
    }
    return -1; /* 28-31 or indefinite not allowed in canonical CBOR here */
}

/* Read a NUL-free UTF-8 string into a freshly malloc'd buffer. */
static char *cbor_read_str(Cbor *c) {
    uint64_t len;
    int mt = cbor_read_head(c, &len);
    if (mt != 3) return NULL;            /* major type 3 = text string */
    if (len > MAX_STR_LEN) return NULL;
    char *s = (char *)malloc(len + 1);
    if (!s) return NULL;
    if (len > 0) {
        if (c->p + len > c->end) { free(s); return NULL; }
        memcpy(s, c->p, len);
        c->p += len;
    }
    s[len] = '\0';
    /* reject embedded NUL */
    for (uint64_t k = 0; k < len; k++) if (s[k] == '\0') { free(s); return NULL; }
    return s;
}

static int cbor_read_uint(Cbor *c, uint64_t *out) {
    uint64_t v;
    int mt = cbor_read_head(c, &v);
    if (mt != 0) return -1;              /* major type 0 = unsigned int */
    *out = v;
    return 0;
}

/* ------------------------------------------------------------------ */
/* Validation helpers                                                  */
/* ------------------------------------------------------------------ */

static int is_absolute(const char *p) {
    return p && p[0] == '/';
}

/* regex equivalent for env: ^[^\x00=]+=[^\x00]*$ (cbor_read_str already
 * rejects NUL); we only need the KEY=VALUE shape. */
static int env_entry_valid(const char *e) {
    if (!e || !e[0]) return 0;
    const char *eq = strchr(e, '=');
    if (!eq || eq == e) return 0;
    /* no NUL already guaranteed; no '=' in key (first '=' is separator) */
    return 1;
}

/* ------------------------------------------------------------------ */
/* CBOR LaunchSpec decode                                              */
/* ------------------------------------------------------------------ */

static void launchspec_free(LaunchSpec *ls) {
    if (!ls) return;
    free(ls->executable);
    free(ls->cwd);
    if (ls->argv) { for (size_t i=0;i<ls->argv_n;i++) free(ls->argv[i]); free(ls->argv); }
    if (ls->env)  { for (size_t i=0;i<ls->env_n;i++)  free(ls->env[i]);  free(ls->env); }
    if (ls->ae_names) { for (size_t i=0;i<ls->ae_n;i++) free(ls->ae_names[i]); free(ls->ae_names); }
    if (ls->ae_paths) { for (size_t i=0;i<ls->ae_n;i++) free(ls->ae_paths[i]); free(ls->ae_paths); }
    memset(ls, 0, sizeof(*ls));
}

/* Decode a map entry whose key is one of the known field names. */
static int decode_launchspec(const unsigned char *cbor, size_t len, LaunchSpec *out) {
    Cbor c = { cbor, cbor + len };
    memset(out, 0, sizeof(*out));

    uint64_t nitems;
    int mt = cbor_read_head(&c, &nitems);   /* map header */
    if (mt != 5) return -1;                 /* major type 5 = map */

    for (uint64_t i = 0; i < nitems; i++) {
        char *key = cbor_read_str(&c);
        if (!key) return -1;
        /* peek the value's major type to dispatch */
        const unsigned char *save = c.p;
        uint64_t vlen;
        int vmt = cbor_read_head(&c, &vlen);
        c.p = save;                          /* rewind; readers re-read head */

        if (strcmp(key, "schemaVersion") == 0) {
            uint64_t sv;
            if (cbor_read_uint(&c, &sv) < 0 || sv != 1) { free(key); return -1; }
        } else if (strcmp(key, "executable") == 0) {
            free(out->executable);
            out->executable = cbor_read_str(&c);
            if (!out->executable) { free(key); return -1; }
        } else if (strcmp(key, "argv") == 0) {
            if (vmt != 4) { free(key); return -1; }   /* array */
            c.p = save;                              /* re-read array head */
            uint64_t arrn;
            if (cbor_read_head(&c, &arrn) != 4) { free(key); return -1; }
            if (arrn > MAX_ARGV_ENTRIES) { free(key); return -1; }
            out->argv = (char **)calloc(arrn + 1, sizeof(char *));
            if (!out->argv) { free(key); return -1; }
            size_t total = 0;
            for (uint64_t k = 0; k < arrn; k++) {
                out->argv[k] = cbor_read_str(&c);
                if (!out->argv[k]) { free(key); return -1; }
                total += strlen(out->argv[k]) + 1;
                out->argv_n++;
            }
            if (total > MAX_ARGV_BYTES) { free(key); return -1; }
        } else if (strcmp(key, "cwd") == 0) {
            free(out->cwd);
            out->cwd = cbor_read_str(&c);
            if (!out->cwd) { free(key); return -1; }
        } else if (strcmp(key, "env") == 0) {
            if (vmt != 4) { free(key); return -1; }
            c.p = save;
            uint64_t arrn;
            if (cbor_read_head(&c, &arrn) != 4) { free(key); return -1; }
            if (arrn > MAX_ENV_ENTRIES) { free(key); return -1; }
            out->env = (char **)calloc(arrn + 1, sizeof(char *));
            if (!out->env) { free(key); return -1; }
            for (uint64_t k = 0; k < arrn; k++) {
                out->env[k] = cbor_read_str(&c);
                if (!out->env[k]) { free(key); return -1; }
                if (!env_entry_valid(out->env[k])) { free(key); return -1; }
                out->env_n++;
            }
        } else if (strcmp(key, "allowedExecutables") == 0) {
            if (vmt != 5) { free(key); return -1; }  /* map */
            c.p = save;
            uint64_t mapn;
            if (cbor_read_head(&c, &mapn) != 5) { free(key); return -1; }
            if (mapn > MAX_ALLOWED_ENTRIES) { free(key); return -1; }
            out->ae_names = (char **)calloc(mapn, sizeof(char *));
            out->ae_paths = (char **)calloc(mapn, sizeof(char *));
            if (!out->ae_names || !out->ae_paths) { free(key); return -1; }
            for (uint64_t k = 0; k < mapn; k++) {
                out->ae_names[k] = cbor_read_str(&c);
                out->ae_paths[k] = cbor_read_str(&c);
                if (!out->ae_names[k] || !out->ae_paths[k]) { free(key); return -1; }
                if (!is_absolute(out->ae_paths[k])) { free(key); return -1; }
                out->ae_n++;
            }
        } else {
            /* unknown key: skip the value. Determined-skip via major type. */
            (void)vmt;
            /* re-read and skip one value of any major type */
            uint64_t skip;
            int smt = cbor_read_head(&c, &skip);
            if (smt < 0) { free(key); return -1; }
            if (smt == 2 || smt == 3) { c.p += skip; }            /* bytes/text */
            else if (smt == 4 || smt == 5) {                       /* array/map */
                for (uint64_t k = 0; k < skip * 2; k++) {
                    /* best-effort recursive skip: not needed for the fixed
                     * shape (no nested containers in unknown values we
                     * expect); if encountered, fail closed. */
                    free(key); return -1;
                }
            }
            /* 0,1,7 (uint/nint/simple/float) consumed by the head read */
        }
        free(key);
    }

    /* required fields */
    if (!out->executable || !out->cwd || !out->argv || out->argv_n == 0)
        return -1;
    if (!is_absolute(out->cwd)) return -1;
    return 0;
}

/* ------------------------------------------------------------------ */
/* Mounts + forwarder + control port                                  */
/* ------------------------------------------------------------------ */

static void do_mounts(void) {
#ifdef __linux__
    if (mount("/dev/vdb", "/skill", "ext4", MS_RDONLY, NULL) < 0)
        die("mount /dev/vdb /skill failed");
    if (mount("/dev/vdc", "/etc/skill-ca", "ext4", MS_RDONLY, NULL) < 0)
        die("mount /dev/vdc /etc/skill-ca failed");
    if (mount("tmpfs", "/tmp", "tmpfs", 0, NULL) < 0)
        die("mount tmpfs /tmp failed");
    if (mount("tmpfs", "/run", "tmpfs", 0, NULL) < 0)
        die("mount tmpfs /run failed");
#else
    /* host-side compile smoke only; the guest rootfs is Linux. */
    (void)0;
#endif
}

/* Loopback<->vsock forwarder: accept 127.0.0.1:vsockPort, relay to
 * AF_VSOCK CID=2 (host) on the same port. Forked so PID 1 stays free
 * to execve the workload. The child is reaped implicitly once the
 * workload execve's (it becomes the only live task the host cares about
 * via krun_start_enter's stdio bridge). */
static void start_forwarder(void) {
    /* read vsockPort from the LaunchSpec would require decoding first;
     * the spec orders the forwarder BEFORE decode. The host helper passes
     * vsockPort via the krun_add_vsock_port call (host side); the guest
     * forwarder binds the SAME port number. We carry it via an env var
     * OCTOPUS_VSOCK_PORT set by the host in trustedEnv, since argv[1] is
     * the launch-spec token and cannot be read before decode.
     *
     * If the env var is absent, the forwarder is skipped (the control
     * channel still works via the virtio-console port). */
    const char *port_s = getenv("OCTOPUS_VSOCK_PORT");
    if (!port_s || !port_s[0]) return;
    char *end = NULL;
    unsigned long port = strtoul(port_s, &end, 10);
    if (end == port_s || port == 0 || port > 65535) return;

    pid_t pid = fork();
    if (pid < 0) return;                 /* fork failure non-fatal for forwarder */
    if (pid > 0) return;                 /* parent (PID 1) continues to decode */

#if OCTOPUS_HAVE_VSOCK
    uint16_t vsock_port = (uint16_t)port;
    /* child: become the forwarder. Never return. */
    int lfd = socket(AF_INET, SOCK_STREAM, 0);
    if (lfd < 0) _exit(0);
    struct sockaddr_in la;
    memset(&la, 0, sizeof(la));
    la.sin_family = AF_INET;
    la.sin_port = htons(vsock_port);
    la.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    int opt = 1;
    setsockopt(lfd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    if (bind(lfd, (struct sockaddr *)&la, sizeof(la)) < 0) _exit(0);
    if (listen(lfd, 1) < 0) _exit(0);
    for (;;) {
        int cfd = accept(lfd, NULL, NULL);
        if (cfd < 0) continue;
        int vfd = socket(AF_VSOCK, SOCK_STREAM, 0);
        if (vfd < 0) { close(cfd); continue; }
        struct sockaddr_vm va;
        memset(&va, 0, sizeof(va));
        va.svm_family = AF_VSOCK;
        va.svm_cid = VMADDR_CID_HOST;     /* 2 */
        va.svm_port = vsock_port;
        if (connect(vfd, (struct sockaddr *)&va, sizeof(va)) < 0) {
            close(vfd); close(cfd); continue;
        }
        /* bidirectional relay: fork one process per direction */
        pid_t r = fork();
        if (r == 0) { char buf[4096]; ssize_t n; while ((n=read(cfd,buf,sizeof(buf)))>0) { ssize_t w=0; while (w<n) { ssize_t k=write(vfd,buf+w,n-w); if (k<=0) break; w+=k; } } _exit(0); }
        char buf2[4096]; ssize_t n2;
        while ((n2 = read(vfd, buf2, sizeof(buf2))) > 0) {
            ssize_t w = 0; while (w < n2) { ssize_t k = write(cfd, buf2+w, n2-w); if (k<=0) break; w += k; }
        }
        close(vfd); close(cfd);
        if (r > 0) waitpid(r, NULL, 0);
    }
    /* not reached */
#else
    /* host-side compile smoke (no AF_VSOCK); the real guest build is Linux. */
    _exit(0);
#endif
    _exit(0);
}

/* Scan /sys/class/virtio-ports/<port>/name for a port named `want`, open the
 * matching /dev/vportNpM read/write, return its fd (or -1 if absent). Used to
 * locate the octopus-control port. */
static int open_named_port(const char *want) {
    DIR *d = opendir("/sys/class/virtio-ports");
    if (!d) return -1;
    struct dirent *de;
    int fd = -1;
    while ((de = readdir(d)) != NULL) {
        if (de->d_name[0] == '.') continue;
        char name_path[512];
        int n = snprintf(name_path, sizeof(name_path),
                          "/sys/class/virtio-ports/%s/name", de->d_name);
        if (n < 0 || (size_t)n >= sizeof(name_path)) continue;
        int nf = open(name_path, O_RDONLY);
        if (nf < 0) continue;
        char buf[64];
        ssize_t r = read(nf, buf, sizeof(buf) - 1);
        close(nf);
        if (r <= 0) continue;
        buf[r] = '\0';
        /* strip trailing newline */
        while (r > 0 && (buf[r-1] == '\n' || buf[r-1] == '\r')) buf[--r] = '\0';
        if (strcmp(buf, want) == 0) {
            char dev_path[512];
            int m = snprintf(dev_path, sizeof(dev_path), "/dev/%s", de->d_name);
            if (m < 0 || (size_t)m >= sizeof(dev_path)) continue;
            fd = open(dev_path, O_RDWR);
            if (fd >= 0) break;
        }
    }
    closedir(d);
    return fd;
}

static int open_control_port(void) {
    return open_named_port("octopus-control");
}

/* TEMP DIAGNOSTIC helpers (remove with the diag block in
 * redirect_workload_stdio once the stdio relay is proven). */
static void diag_report_ports(void) {
    char msg[900];
    size_t off = (size_t)snprintf(msg, sizeof(msg), "{\"diag\":\"ports=");
    DIR *d = opendir("/sys/class/virtio-ports");
    if (!d) {
        snprintf(msg + off, sizeof(msg) - off, "NO_SYSFS\"}");
        control_write(msg);
        return;
    }
    struct dirent *de;
    while ((de = readdir(d)) != NULL && off < sizeof(msg) - 80) {
        if (de->d_name[0] == '.') continue;
        char np[512];
        int n = snprintf(np, sizeof(np), "/sys/class/virtio-ports/%s/name", de->d_name);
        if (n < 0 || (size_t)n >= sizeof(np)) continue;
        int nf = open(np, O_RDONLY);
        if (nf < 0) continue;
        char buf[64];
        ssize_t r = read(nf, buf, sizeof(buf) - 1);
        close(nf);
        if (r <= 0) continue;
        buf[r] = '\0';
        while (r > 0 && (buf[r-1] == '\n' || buf[r-1] == '\r')) buf[--r] = '\0';
        off += (size_t)snprintf(msg + off, sizeof(msg) - off, "%s:%s;", de->d_name, buf);
    }
    closedir(d);
    snprintf(msg + off, sizeof(msg) - off, "\"}");
    control_write(msg);
}

static void diag_report_fd1(const char *tag) {
    char link[128];
    ssize_t n = readlink("/proc/self/fd/1", link, sizeof(link) - 1);
    char msg[192];
    if (n > 0) {
        link[n] = '\0';
        snprintf(msg, sizeof(msg), "{\"diag\":\"%s fd1=%s\"}", tag, link);
    } else {
        snprintf(msg, sizeof(msg), "{\"diag\":\"%s fd1=readlink-failed\"}", tag);
    }
    control_write(msg);
}

/* Redirect the workload's stdio onto the "krun-stdio" named virtio-console
 * port BEFORE execve. The host helper registers that port on the octopus-control
 * multiport device (input fd 7 / output fd 6 on the host), so anything the
 * workload writes to fd 1/2 reaches the host's helper stdout raw, and host
 * writes reach the workload's fd 0; the octopus-control port stays dedicated
 * to the ready/error frames. vm-init is the guest PID 1 (NOT libkrun's init),
 * so nothing else performs this redirection -- at boot this process's fd 1 is
 * a stray virtio-console port (e.g. /dev/vport2p2) that goes nowhere, and
 * without the redirect the workload's console.log never reaches the host (the
 * root cause of the G1/G2 NO-GO "DONE marker absent").
 *
 * A named port is used (not /dev/console): krun_start_enter takes over the
 * helper's fd 0/1, so the implicit console's output cannot be sunk to the
 * host stdout, and krun_set_console_output to a /dev/fd/N alias drops the
 * bytes (verified twice). The named multiport port relays reliably -- the
 * octopus-control ready frame on the same device proves it.
 *
 * Best-effort: if the port is absent the fds are left as-is rather than
 * failing the workload (ready/error frames ride octopus-control anyway). The
 * octopus-control fd is untouched. */
static void redirect_workload_stdio(void) {
    /* TEMP DIAGNOSTIC (remove once the stdio relay is proven end-to-end):
     * report the guest's view of the console ports over octopus-control (the
     * proven-reliable channel) so a host-side NO-GO is diagnosable from the
     * INSIDE. Frames concatenate onto the control stream. */
    diag_report_ports();
    diag_report_fd1("before");
    int p = open_named_port("krun-stdio");
    if (p < 0) {
        control_write("{\"diag\":\"stdio=MISSING\"}");
        return;
    }
    {
        char msg[64];
        snprintf(msg, sizeof(msg), "{\"diag\":\"stdio_fd=%d\"}", p);
        control_write(msg);
    }
    dup2(p, STDIN_FILENO);
    dup2(p, STDOUT_FILENO);
    dup2(p, STDERR_FILENO);
    /* Only close the original if it isn't itself one of the stdio slots
     * (open() could return fd 0 if stdin were free; closing it then would
     * undo the dup2). */
    if (p > STDERR_FILENO) close(p);
    /* Prove the relay from the inside: one line through the new fd 1. If this
     * reaches the host's helper stdout, the port delivers and any later
     * missing workload output is a post-execve problem; if it does not, the
     * port's host-side sink is the culprit. */
    const char probe_line[] = "DIAG-STDOUT-ALIVE\n";
    ssize_t w = write(STDOUT_FILENO, probe_line, sizeof(probe_line) - 1);
    {
        char msg[96];
        snprintf(msg, sizeof(msg), "{\"diag\":\"test_write=%d errno=%d\"}",
                 (int)w, (w < 0) ? errno : 0);
        control_write(msg);
    }
    diag_report_fd1("after");
}

/* ------------------------------------------------------------------ */
/* cwd canonicalization under /skill                                   */
/* ------------------------------------------------------------------ */

/* /dev/vdb is mounted ro at /skill. cwd must be absolute and resolve
 * (realpath) under /skill with no .. or symlink breakout. */
static int cwd_under_skill(const char *cwd, char *resolved, size_t resolved_sz) {
    if (!is_absolute(cwd)) return -1;
    /* /skill must exist (mounted). */
    char real[PATH_MAX];
    if (!realpath(cwd, real)) return -1;
    /* MUST be under /skill (exactly "/skill" or "/skill/..."). */
    size_t sklen = strlen("/skill");
    if (strncmp(real, "/skill", sklen) != 0) return -1;
    if (real[sklen] != '\0' && real[sklen] != '/') return -1;
    if (strlen(real) >= resolved_sz) return -1;
    strcpy(resolved, real);
    return 0;
}

/* ------------------------------------------------------------------ */
/* Executable resolution -- THREE branches                            */
/* ------------------------------------------------------------------ */

/* Returns a freshly malloc'd resolved path, or NULL on reject. */
static char *resolve_executable(const LaunchSpec *ls) {
    const char *exe = ls->executable;
    if (!exe || !exe[0]) return NULL;

    /* Branch 1: /skill/... -- realpath must stay under /skill. */
    if (strncmp(exe, "/skill/", 7) == 0 || strcmp(exe, "/skill") == 0) {
        char real[PATH_MAX];
        if (!realpath(exe, real)) return NULL;
        size_t sklen = strlen("/skill");
        if (strncmp(real, "/skill", sklen) != 0) return NULL;
        if (real[sklen] != '\0' && real[sklen] != '/') return NULL;
        return strdup(real);
    }

    /* Branch 2: rootfs-absolute (not under /skill) -- must EXACTLY match an
     * allowedExecutables value. */
    if (is_absolute(exe)) {
        for (size_t i = 0; i < ls->ae_n; i++) {
            if (strcmp(exe, ls->ae_paths[i]) == 0) {
                /* verify it exists + is a regular file */
                struct stat st;
                if (stat(exe, &st) == 0 && S_ISREG(st.st_mode))
                    return strdup(exe);
                return NULL;
            }
        }
        return NULL;                  /* rootfs-abs not in allowlist */
    }

    /* Branch 3: bare name -- resolved via allowedExecutables map. */
    for (size_t i = 0; i < ls->ae_n; i++) {
        if (strcmp(exe, ls->ae_names[i]) == 0) {
            const char *resolved = ls->ae_paths[i];
            struct stat st;
            if (stat(resolved, &st) == 0 && S_ISREG(st.st_mode))
                return strdup(resolved);
            return NULL;
        }
    }

    /* "other" -- reject */
    return NULL;
}

/* ------------------------------------------------------------------ */
/* main -- PID 1 bootstrap                                             */
/* ------------------------------------------------------------------ */

int main(int argc, char **argv) {
    if (argc < 2 || !argv[1] || !argv[1][0])
        die("usage: octopus-vm-init <base64url-cbor-launch-spec>");

    /* Step 1-3: mounts. /skill and /etc/skill-ca must pre-exist as
     * mount points in the rootfs (created by the rootfs build). */
    do_mounts();

    /* Step 4: forwarder (best-effort; reads OCTOPUS_VSOCK_PORT from env). */
    start_forwarder();

    /* Step 5: control port. */
    g_control_fd = open_control_port();

    /* Step 6: decode + validate. */
    size_t tokenLen = strlen(argv[1]);
    size_t cborLen = 0;
    unsigned char *cbor = b64url_decode(argv[1], tokenLen, &cborLen);
    if (!cbor || cborLen == 0)
        die("launch-spec base64url decode failed");
    if (cborLen > MAX_DECODED_BYTES) { free(cbor); die("launch-spec too large"); }

    LaunchSpec ls;
    if (decode_launchspec(cbor, cborLen, &ls) < 0) {
        free(cbor); die("launch-spec decode/validate failed");
    }
    free(cbor);

    /* Step 7: cwd canonicalization under /skill. */
    char cwd_real[PATH_MAX];
    if (cwd_under_skill(ls.cwd, cwd_real, sizeof(cwd_real)) < 0) {
        launchspec_free(&ls); die("cwd not under /skill");
    }

    /* Step 8: ready. */
    control_write("{\"ready\":true}");

    /* Step 9: resolve executable (three branches). */
    char *resolved = resolve_executable(&ls);
    if (!resolved) {
        launchspec_free(&ls); die("unresolvable executable");
    }

    /* Step 10: chdir, redirect stdio, CLOSE control, execve. */
    if (chdir(cwd_real) < 0) {
        free(resolved); launchspec_free(&ls); die("chdir cwd failed");
    }
    /* Route the workload's stdio onto the "krun-stdio" named port so its
     * output reaches the host via the helper's krun-stdio port pipe. */
    redirect_workload_stdio();
    if (g_control_fd >= 0) { close(g_control_fd); g_control_fd = -1; }

    /* execve: pathname=resolved, argv=ls.argv (argv[0]=program name),
     * envp=ls.env. If env is empty, pass a minimal environ. */
    char *empty_envp[] = { NULL };
    char **envp = (ls.env && ls.env_n > 0) ? ls.env : empty_envp;
    execve(resolved, ls.argv, envp);

    /* execve only returns on failure. */
    free(resolved);
    launchspec_free(&ls);
    die("execve failed");
    /* not reached */
    return 127;
}
