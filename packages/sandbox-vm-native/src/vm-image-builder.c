/*
 * vm-image-builder.c — deterministic sealed read-only image writer.
 *
 * Builds sealed read-only block images via DESCRIPTOR-RELATIVE traversal
 * (spec §Block-image builder & TOCTOU, lines 906–976). Two modes:
 *
 *   vm-image-builder snapshot    <sourceDir> <expectedSnapshotDigest> <outPath>
 *   vm-image-builder single-file <sourcePath> <guestName> <expectedFileDigest> <outPath>
 *
 * Hard constraints (R3 P1-4 descriptor-relative; R4 P1-2 two-method + corrections):
 *   - openat(dirFd, name, O_RDONLY|O_NOFOLLOW|O_CLOEXEC); fstat the FD.
 *   - REJECT "." and ".." by STRING COMPARE before openat
 *     (openat(dirFd,"..") reaches the parent — the fd pins WHICH directory's
 *     children are enumerated, not whether ".." resolves).
 *   - Regular files: reject st_nlink > 1 (hardlink). Directories: NO nlink
 *     check; use a (st_dev, st_ino) visited-set for cycles/revisits.
 *   - Reject device / socket / fifo / symlink (O_NOFOLLOW fails symlinks at open).
 *   - Read contents via the SAME fd (fd is the identity — no lstat→open race).
 *   - Verify st_dev matches the root dir fd (reject mount-table tricks).
 *   - Recompute the canonical snapshot/file digest during copy and assert
 *     == expected. On mismatch: delete output, exit non-zero (fail closed).
 *   - Seal: O_CREAT|O_EXCL, fsync, chmod 0444.
 *   - Compute an INDEPENDENT block-image byte digest (sha256 over .img bytes).
 *
 * CANONICAL SNAPSHOT DIGEST (snapshot mode): MUST match snapshot.ts canonicalDigest
 * exactly. snapshot.ts computes 'sha256:' + sha256(JSON.stringify(sorted)) where
 * `sorted` is the manifest array (root "" excluded, sorted by path in UTF-16 code-
 * unit order) of entries:
 *     file:  {"path":"<p>","type":"file","mode":<execbits>,"sha256":"<bare 64 hex>"}
 *     dir:   {"path":"<p>","type":"dir","mode":<execbits>}
 *   - path: forward-slash relative, NFC-normalized (we assume ASCII skill paths;
 *     non-ASCII may fail-closed on digest mismatch, which is a safe posture).
 *   - mode: st_mode & 0111 (exec bits only). The builder runs on the snapshot
 *     ROOT (already chmod 0555 by snapshot.ts), so exec bits are preserved.
 *   - sha256: BARE 64-char lowercase hex of the file bytes (NOT prefixed).
 *   - JSON: RFC 8259, keys in insertion order, no whitespace; '/' not escaped.
 * This file reproduces that JSON serialization byte-for-byte for ASCII paths.
 *
 * Symlinks: snapshot.ts ACCEPTS in-root symlinks (records linkTarget). The VM
 * builder REJECTS them (spec line 928; plan Step 3 test asserts rejection) — a
 * stricter posture for the sealed image. A snapshot tree containing a symlink
 * therefore fails to build a VM image (fail closed); trees without symlinks
 * (the normal case) produce a manifest identical to snapshot.ts, so digests match.
 *
 * IMAGE FORMAT: a minimal self-contained ext4 writer — NO mkfs.ext4/docker/
 * Homebrew. Read-only, single block group, 1024-byte blocks, no journal, NO
 * metadata checksums (s_feature_ro_compat=0). Writes: superblock, group
 * descriptor, block/inode bitmaps, inode table (root=inode 2, content from
 * inode 11), directory blocks + file data blocks. Enough for the guest kernel
 * to mount read-only as a virtio-blk backing file. Mountability is verified at
 * L3 (Linux, CI-owned); Task 13's own tests verify rejection behavior only.
 *
 * Build: cc -std=c11 -Wall -Wextra -Werror. Requires _GNU_SOURCE (defined
 * below, before the includes) — this writer's descriptor-relative traversal
 * uses openat/fdopendir/fchmod and O_CLOEXEC/O_NOFOLLOW/F_DUPFD_CLOEXEC
 * (POSIX.1-2008) plus O_DIRECTORY (a Linux/GNU extension). Strict -std=c11
 * (__STRICT_ANSI__) hides all of these, so the compile fails without it.
 */

/* _GNU_SOURCE exposes the descriptor-relative syscalls + flags this file uses
 * (openat, fdopendir, fchmod, O_CLOEXEC, O_NOFOLLOW, F_DUPFD_CLOEXEC,
 * O_DIRECTORY). Must precede every system header. It also implies
 * _POSIX_C_SOURCE=200809L and _ATFILE_SOURCE, and overrides the strict-ISO
 * hiding that -std=c11 (__STRICT_ANSI__) applies to the default feature set. */
#define _GNU_SOURCE

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdarg.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <dirent.h>

/* ---- SHA-256 (self-contained, public-domain style) ----------------------- */

typedef struct {
    uint32_t state[8];
    uint64_t bitlen;
    uint8_t  data[64];
    size_t   datalen;
} sha256_ctx;

static const uint32_t SHA256_K[64] = {
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
};

#define SHA256_ROTR(a,b) (((a) >> (b)) | ((a) << (32 - (b))))

static void sha256_init(sha256_ctx *c) {
    c->datalen = 0; c->bitlen = 0;
    c->state[0]=0x6a09e667; c->state[1]=0xbb67ae85; c->state[2]=0x3c6ef372; c->state[3]=0xa54ff53a;
    c->state[4]=0x510e527f; c->state[5]=0x9b05688c; c->state[6]=0x1f83d9ab; c->state[7]=0x5be0cd19;
}

static void sha256_transform(sha256_ctx *c, const uint8_t d[64]) {
    uint32_t m[64], a,b,cc,dd,e,f,g,h, i, t1, t2;
    for (i = 0; i < 16; i++)
        m[i] = ((uint32_t)d[i*4]<<24)|((uint32_t)d[i*4+1]<<16)|((uint32_t)d[i*4+2]<<8)|((uint32_t)d[i*4+3]);
    for (; i < 64; i++) {
        uint32_t s0 = SHA256_ROTR(m[i-15],7) ^ SHA256_ROTR(m[i-15],18) ^ (m[i-15] >> 3);
        uint32_t s1 = SHA256_ROTR(m[i-2],17) ^ SHA256_ROTR(m[i-2],19) ^ (m[i-2] >> 10);
        m[i] = m[i-16] + s0 + m[i-7] + s1;
    }
    a=c->state[0]; b=c->state[1]; cc=c->state[2]; dd=c->state[3];
    e=c->state[4]; f=c->state[5]; g=c->state[6]; h=c->state[7];
    for (i = 0; i < 64; i++) {
        uint32_t S1 = SHA256_ROTR(e,6) ^ SHA256_ROTR(e,11) ^ SHA256_ROTR(e,25);
        uint32_t ch = (e & f) ^ ((~e) & g);
        t1 = h + S1 + ch + SHA256_K[i] + m[i];
        uint32_t S0 = SHA256_ROTR(a,2) ^ SHA256_ROTR(a,13) ^ SHA256_ROTR(a,22);
        uint32_t mj = (a & b) ^ (a & cc) ^ (b & cc);
        t2 = S0 + mj;
        h=g; g=f; f=e; e=dd+t1; dd=cc; cc=b; b=a; a=t1+t2;
    }
    c->state[0]+=a; c->state[1]+=b; c->state[2]+=cc; c->state[3]+=dd;
    c->state[4]+=e; c->state[5]+=f; c->state[6]+=g; c->state[7]+=h;
}

static void sha256_update(sha256_ctx *c, const void *data, size_t len) {
    const uint8_t *p = (const uint8_t*)data;
    for (size_t i = 0; i < len; i++) {
        c->data[c->datalen++] = p[i];
        if (c->datalen == 64) {
            sha256_transform(c, c->data);
            c->bitlen += 512;
            c->datalen = 0;
        }
    }
}

static void sha256_final(sha256_ctx *c, uint8_t out[32]) {
    size_t i = c->datalen;
    c->data[i++] = 0x80;
    if (c->datalen < 56) {
        while (i < 56) c->data[i++] = 0x00;
    } else {
        while (i < 64) c->data[i++] = 0x00;
        sha256_transform(c, c->data);
        memset(c->data, 0, 56);
    }
    c->bitlen += (uint64_t)c->datalen * 8;
    c->data[63] = (uint8_t)(c->bitlen);
    c->data[62] = (uint8_t)(c->bitlen >> 8);
    c->data[61] = (uint8_t)(c->bitlen >> 16);
    c->data[60] = (uint8_t)(c->bitlen >> 24);
    c->data[59] = (uint8_t)(c->bitlen >> 32);
    c->data[58] = (uint8_t)(c->bitlen >> 40);
    c->data[57] = (uint8_t)(c->bitlen >> 48);
    c->data[56] = (uint8_t)(c->bitlen >> 56);
    sha256_transform(c, c->data);
    for (i = 0; i < 4; i++) {
        for (int j = 0; j < 8; j++)
            out[j*4+i] = (uint8_t)((c->state[j] >> (24 - i*8)) & 0xff);
    }
}

static void sha256_hex(const uint8_t in[32], char out[65]) {
    static const char *H = "0123456789abcdef";
    for (int i = 0; i < 32; i++) { out[i*2]=H[in[i]>>4]; out[i*2+1]=H[in[i]&0xf]; }
    out[64] = '\0';
}

/* ---- die() (fail-closed: unlink partial output if path known) ------------- */

static const char *g_outPath = NULL;

static void die(const char *fmt, ...) {
    va_list ap; va_start(ap, fmt);
    fprintf(stderr, "vm-image-builder: ");
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    if (errno) fprintf(stderr, ": %s", strerror(errno));
    fprintf(stderr, "\n");
    if (g_outPath) { (void)unlink(g_outPath); }   /* best-effort; ignore ENOENT */
    _exit(1);
}

/* ---- little-endian helpers ----------------------------------------------- */

static void put_u32(uint8_t *b, uint32_t v) { b[0]=v&0xff; b[1]=(v>>8)&0xff; b[2]=(v>>16)&0xff; b[3]=(v>>24)&0xff; }
static void put_u16(uint8_t *b, uint16_t v) { b[0]=v&0xff; b[1]=(v>>8)&0xff; }

/* ---- ext4 geometry (minimal read-only, single block group) --------------- */
/*
 * Layout (1024-byte blocks):
 *   block 0:          padding (boot)
 *   block 1:          superblock
 *   block 2:          group descriptor table (one 32-byte descriptor)
 *   block 3:          block bitmap
 *   block 4:          inode bitmap
 *   blocks 5..5+NIT-1: inode table (N_INODES inodes of INODE_SIZE each)
 *   then data blocks (directory entries + file contents)
 * No journal, no metadata checksums (s_feature_ro_compat=0). Read-only mount.
 */

#define BLOCK_SIZE      1024
#define INODE_SIZE      128
#define N_INODES        256
#define INODE_TABLE_BLOCKS  ((N_INODES * INODE_SIZE + BLOCK_SIZE - 1) / BLOCK_SIZE)  /* 32 */
#define SB_BLOCK        1
#define GDT_BLOCK       2
#define BBM_BLOCK       3
#define IBM_BLOCK      4
#define INODE_TABLE_FIRST 5
#define DATA_FIRST      (INODE_TABLE_FIRST + INODE_TABLE_BLOCKS)   /* 37 */
#define ROOT_INO        2
#define FIRST_USR_INO   11   /* rev 1: inodes < 11 reserved; content starts here */

_Static_assert(sizeof(struct { uint8_t b[INODE_SIZE]; }) == INODE_SIZE, "inode geometry");

/* ext4 superblock fields (offsets per kernel struct ext4_super_block). */
struct ext4_inode {
    uint16_t i_mode;          /* 0:  file mode */
    uint16_t i_uid;           /* 2:  owner UID */
    uint32_t i_size_lo;       /* 4:  size lower 32 */
    uint32_t i_atime;         /* 8 */
    uint32_t i_ctime;         /* 12 */
    uint32_t i_mtime;         /* 16 */
    uint32_t i_dtime;         /* 20 */
    uint16_t i_gid;           /* 24 */
    uint16_t i_links_count;  /* 26 */
    uint32_t i_blocks_lo;     /* 28: 512-byte sectors */
    uint32_t i_flags;         /* 32 */
    uint32_t i_osd1;          /* 36 */
    uint32_t i_block[15];     /* 40:  12 direct + 1 indirect + 1 double + 1 triple */
    uint32_t i_generation;   /* 100 */
    uint32_t i_file_acl_lo;  /* 104 */
    uint32_t i_size_hi;       /* 108: i_dir_acl for directories */
    uint32_t i_obso_faddr;   /* 112 */
    uint16_t i_blocks_hi;    /* 116 */
    uint16_t i_file_acl_hi;  /* 118 */
    uint16_t i_uid_hi;        /* 120 */
    uint16_t i_gid_hi;        /* 122 */
    uint16_t i_checksum_lo;  /* 124 */
    uint16_t i_reserved;     /* 126 */
} __attribute__((packed));
_Static_assert(sizeof(struct ext4_inode) == 128, "ext4_inode must be 128 bytes");

/* ext4 directory entry (linked-list, variable length, 4-byte aligned rec_len). */
struct ext4_dirent {
    uint32_t inode;
    uint16_t rec_len;
    uint8_t  name_len;
    uint8_t  file_type;
    char     name[];
} __attribute__((packed));

#define EXT4_S_MAGIC                0xEF53
#define EXT4_S_ERRORS_CONTINUE       1
#define EXT4_S_REV_DYNAMIC           1
#define EXT4_FEATURE_INCOMPAT_FILETYPE 0x0002

/* ---- image writer -------------------------------------------------------- */

typedef struct {
    int fd;
    uint64_t cursor;   /* next data block byte offset (>= DATA_FIRST*BLOCK_SIZE) */
} img_t;

static void xwrite_at(img_t *im, uint64_t off, const void *buf, size_t len) {
    if (lseek(im->fd, (off_t)off, SEEK_SET) == (off_t)-1) die("lseek output");
    const uint8_t *p = (const uint8_t*)buf;
    size_t done = 0;
    while (done < len) {
        ssize_t n = write(im->fd, p + done, len - done);
        if (n < 0) { if (errno == EINTR) continue; die("write output"); }
        done += (size_t)n;
    }
}

static void xread_all(int fd, void *buf, size_t len) {
    uint8_t *p = (uint8_t*)buf; size_t done = 0;
    while (done < len) {
        ssize_t n = read(fd, p + done, len - done);
        if (n < 0) { if (errno == EINTR) continue; die("read source"); }
        if (n == 0) die("unexpected EOF on source fd");
        done += (size_t)n;
    }
}

static uint64_t alloc_block(img_t *im) {
    uint64_t b = im->cursor;
    im->cursor += BLOCK_SIZE;
    return b;
}

static void write_superblock(img_t *im, uint32_t total_blocks, uint32_t free_blocks, uint32_t free_inodes, uint32_t used_dirs) {
    uint8_t sb[BLOCK_SIZE];
    memset(sb, 0, sizeof(sb));
    put_u32(sb+0x00, N_INODES);                 /* s_inodes_count */
    put_u32(sb+0x04, total_blocks);             /* s_blocks_count_lo */
    put_u32(sb+0x08, 0);                        /* s_r_blocks_count_lo */
    put_u32(sb+0x0C, free_blocks);              /* s_free_blocks_count_lo */
    put_u32(sb+0x10, free_inodes);              /* s_free_inodes_count */
    put_u32(sb+0x14, SB_BLOCK);                 /* s_first_data_block (1 for 1024B blocks) */
    put_u32(sb+0x18, 0);                        /* s_log_block_size (0 => 1024-byte blocks) */
    put_u32(sb+0x1C, 0);                        /* s_log_cluster_size */
    put_u32(sb+0x20, 8 * BLOCK_SIZE);           /* s_blocks_per_group (bitmap coverage) */
    put_u32(sb+0x24, 8 * BLOCK_SIZE);           /* s_clusters_per_group */
    put_u32(sb+0x28, N_INODES);                 /* s_inodes_per_group */
    /* s_mtime 0x2C, s_wtime 0x30, s_mnt_count 0x34, s_max_mnt_count 0x36: zero */
    put_u16(sb+0x38, EXT4_S_MAGIC);
    put_u16(sb+0x3A, 1);                        /* s_state = clean */
    put_u16(sb+0x3C, EXT4_S_ERRORS_CONTINUE);   /* s_errors */
    /* s_minor_rev_level 0x3E: 0 */
    put_u32(sb+0x48, 0);                        /* s_creator_os = Linux */
    put_u32(sb+0x4C, EXT4_S_REV_DYNAMIC);       /* s_rev_level = 1 (dynamic) */
    put_u32(sb+0x54, FIRST_USR_INO);            /* s_first_ino = 11 */
    put_u16(sb+0x58, INODE_SIZE);               /* s_inode_size = 128 */
    /* s_block_group_nr 0x5A: 0 */
    put_u32(sb+0x5C, 0);                        /* s_feature_compat = 0 */
    put_u32(sb+0x60, EXT4_FEATURE_INCOMPAT_FILETYPE); /* s_feature_incompat */
    put_u32(sb+0x64, 0);                        /* s_feature_ro_compat = 0 (no checksums) */
    (void)used_dirs;
    xwrite_at(im, (uint64_t)SB_BLOCK * BLOCK_SIZE, sb, BLOCK_SIZE);
}

static void write_gdt(img_t *im, uint32_t free_blocks, uint32_t free_inodes, uint32_t used_dirs) {
    uint8_t gdt[BLOCK_SIZE];
    memset(gdt, 0, sizeof(gdt));
    put_u32(gdt+0x00, BBM_BLOCK);               /* bg_block_bitmap_lo */
    put_u32(gdt+0x04, IBM_BLOCK);               /* bg_inode_bitmap_lo */
    put_u32(gdt+0x08, INODE_TABLE_FIRST);      /* bg_inode_table_lo */
    put_u16(gdt+0x0C, (uint16_t)free_blocks);  /* bg_free_blocks_count_lo */
    put_u16(gdt+0x0E, (uint16_t)free_inodes);  /* bg_free_inodes_count_lo */
    put_u16(gdt+0x10, (uint16_t)used_dirs);    /* bg_used_dirs_count_lo */
    xwrite_at(im, (uint64_t)GDT_BLOCK * BLOCK_SIZE, gdt, BLOCK_SIZE);
}

static void write_bitmaps(img_t *im, uint32_t highest_used_block, uint32_t highest_used_inode) {
    uint8_t bbm[BLOCK_SIZE], ibm[BLOCK_SIZE];
    memset(bbm, 0, sizeof(bbm));
    memset(ibm, 0, sizeof(ibm));
    /* mark all blocks 0..highest_used_block allocated */
    for (uint32_t b = 0; b <= highest_used_block && (b/8) < BLOCK_SIZE; b++)
        bbm[b / 8] |= (uint8_t)(1u << (b % 8));
    /* mark inodes 1..highest_used_inode allocated (1-10 reserved + content) */
    for (uint32_t i = 1; i <= highest_used_inode && (i/8) < BLOCK_SIZE; i++)
        ibm[i / 8] |= (uint8_t)(1u << (i % 8));
    xwrite_at(im, (uint64_t)BBM_BLOCK * BLOCK_SIZE, bbm, BLOCK_SIZE);
    xwrite_at(im, (uint64_t)IBM_BLOCK * BLOCK_SIZE, ibm, BLOCK_SIZE);
}

static void write_inode(img_t *im, uint32_t ino, const struct ext4_inode *ino_buf) {
    uint64_t off = (uint64_t)INODE_TABLE_FIRST * BLOCK_SIZE + (uint64_t)(ino - 1) * INODE_SIZE;
    xwrite_at(im, off, ino_buf, INODE_SIZE);
}

/* ---- growable byte buffer (for JSON manifest) --------------------------- */

typedef struct { char *p; size_t len, cap; } buf_t;

static void buf_reserve(buf_t *b, size_t add) {
    if (b->len + add + 1 > b->cap) {
        size_t nc = b->cap ? b->cap : 256;
        while (nc < b->len + add + 1) nc *= 2;
        char *np = (char*)realloc(b->p, nc);
        if (!np) die("realloc (manifest buffer)");
        b->p = np; b->cap = nc;
    }
}
static void buf_putc(buf_t *b, char c) { buf_reserve(b, 1); b->p[b->len++] = c; b->p[b->len] = 0; }
static void buf_puts(buf_t *b, const char *s) { size_t n = strlen(s); buf_reserve(b, n); memcpy(b->p+b->len, s, n); b->len += n; b->p[b->len] = 0; }

/* RFC 8259 string escape matching V8 JSON.stringify. '/' is NOT escaped. */
static void buf_jsonstr(buf_t *b, const char *s) {
    buf_putc(b, '"');
    for (const unsigned char *p = (const unsigned char*)s; *p; p++) {
        unsigned char c = *p;
        if (c == '"' || c == '\\') { buf_putc(b, '\\'); buf_putc(b, (char)c); }
        else if (c < 0x20) {
            char esc[8];
            static const char *hex = "0123456789abcdef";
            esc[0]='\\'; esc[1]='u'; esc[2]='0'; esc[3]='0';
            esc[4]=hex[(c>>4)&0xf]; esc[5]=hex[c&0xf]; esc[6]=0;
            buf_puts(b, esc);
        } else {
            buf_putc(b, (char)c);
        }
    }
    buf_putc(b, '"');
}

/* ---- collected file entries ---------------------------------------------- */

typedef struct {
    char *relpath;          /* guest-relative, '/'-separated, no leading '/' */
    uint32_t inode;
    uint8_t  file_type;      /* 1=reg, 2=dir */
    uint32_t mode_exec;      /* st_mode & 0111 */
    uint64_t size;           /* file size (reg) */
    char     sha_hex[65];    /* bare 64-hex of file bytes (reg); empty for dir */
    int content_fd;          /* kept open for the data-block emit pass */
    uint64_t data_block_off;
    uint32_t data_blocks;
    uint32_t n_subdirs;      /* for directory link count */
} entry_t;

#define MAX_ENTRIES 512
static entry_t g_entries[MAX_ENTRIES];
static uint32_t g_nentries = 0;
static uint32_t g_next_inode = FIRST_USR_INO;   /* root=2 assigned explicitly */

static entry_t *new_entry(const char *relpath, uint8_t ftype) {
    if (g_nentries >= MAX_ENTRIES) die("too many entries (>=%d)", MAX_ENTRIES);
    entry_t *e = &g_entries[g_nentries++];
    e->relpath = strdup(relpath);
    if (!e->relpath) die("strdup");
    e->inode = (ftype == 2 && relpath[0] == '\0') ? ROOT_INO : g_next_inode++;
    e->file_type = ftype;
    e->mode_exec = 0;
    e->size = 0;
    e->sha_hex[0] = '\0';
    e->content_fd = -1;
    e->data_block_off = 0;
    e->data_blocks = 0;
    e->n_subdirs = 0;
    return e;
}

/* Comparator for an array of entry_t POINTERS (used by compute_canonical_digest's
 * scratch sorted[] array). */
static int cmp_entry_ptr(const void *a, const void *b) {
    const entry_t *ea = *(const entry_t * const*)a;
    const entry_t *eb = *(const entry_t * const*)b;
    return strcmp(ea->relpath, eb->relpath);
}

/* Comparator for an array of entry_t STRUCTS (used by the emit-phase qsort over
 * the g_entries[] struct array, which gives deterministic block-image byte
 * digests across hosts regardless of readdir ordering). */
static int cmp_entry_struct(const void *a, const void *b) {
    const entry_t *ea = (const entry_t*)a;
    const entry_t *eb = (const entry_t*)b;
    return strcmp(ea->relpath, eb->relpath);
}

/* ---- directory visited-set (st_dev, st_ino) ------------------------------ */

#define MAX_VISITED 1024
static struct { dev_t dev; ino_t ino; } g_visited[MAX_VISITED];
static size_t g_nvisited = 0;

static int visited_has(dev_t dev, ino_t ino) {
    for (size_t i = 0; i < g_nvisited; i++)
        if (g_visited[i].dev == dev && g_visited[i].ino == ino) return 1;
    return 0;
}
static void visited_add(dev_t dev, ino_t ino) {
    if (g_nvisited >= MAX_VISITED) die("visited-set overflow (cycle?)");
    g_visited[g_nvisited].dev = dev;
    g_visited[g_nvisited].ino = ino;
    g_nvisited++;
}

/* ---- traversal ------------------------------------------------------------ */

static dev_t g_root_dev;

static int name_is_dot(const char *name) {
    return (name[0]=='.' && name[1]=='\0') || (name[0]=='.' && name[1]=='.' && name[2]=='\0');
}

/* Compute per-file sha256 (bare hex) by streaming content_fd, then lseek back to 0. */
static void compute_file_sha(int fd, char hex_out[65]) {
    if (lseek(fd, 0, SEEK_SET) == (off_t)-1) die("lseek source for sha");
    sha256_ctx c; sha256_init(&c);
    uint8_t buf[65536];
    for (;;) {
        ssize_t n = read(fd, buf, sizeof(buf));
        if (n < 0) { if (errno == EINTR) continue; die("read source for sha"); }
        if (n == 0) break;
        sha256_update(&c, buf, (size_t)n);
    }
    uint8_t d[32]; sha256_final(&c, d);
    sha256_hex(d, hex_out);
    if (lseek(fd, 0, SEEK_SET) == (off_t)-1) die("lseek source back to 0");
}

static void walk(int dirfd, const char *relprefix, int depth) {
    if (depth > 32) die("directory depth > 32 (cycle?)");

    int dup = fcntl(dirfd, F_DUPFD_CLOEXEC, 0);
    if (dup < 0) die("fcntl dup for readdir");
    DIR *d = fdopendir(dup);
    if (!d) die("fdopendir");
    rewinddir(d);

    struct dirent *de;
    while ((de = readdir(d)) != NULL) {
        const char *name = de->d_name;
        if (name_is_dot(name)) continue;            /* R4: reject "." / ".." by name */

        int cfd = openat(dirfd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
        if (cfd < 0) {
            /* O_NOFOLLOW => symlink triggers ELOOP on macOS/Linux. */
            if (errno == ELOOP) die("reject symlink (O_NOFOLLOW): %s", name);
            die("openat(%s)", name);
        }
        struct stat st;
        if (fstat(cfd, &st) < 0) die("fstat(%s)", name);
        if (st.st_dev != g_root_dev) die("reject cross-device entry: %s", name);

        char rel[4096];
        if (relprefix[0]) snprintf(rel, sizeof(rel), "%s/%s", relprefix, name);
        else              snprintf(rel, sizeof(rel), "%s", name);

        if (S_ISDIR(st.st_mode)) {
            if (visited_has(st.st_dev, st.st_ino)) die("reject dir revisit/cycle: %s", rel);
            visited_add(st.st_dev, st.st_ino);
            entry_t *e = new_entry(rel, 2);
            e->mode_exec = (uint32_t)(st.st_mode & 0111);
            /* tally parent's subdir count for link accounting */
            walk(cfd, rel, depth + 1);
            close(cfd);
            (void)e;
        } else if (S_ISREG(st.st_mode)) {
            if (st.st_nlink > 1) die("reject hardlink (st_nlink=%llu): %s",
                                     (unsigned long long)st.st_nlink, rel);
            entry_t *e = new_entry(rel, 1);
            e->mode_exec = (uint32_t)(st.st_mode & 0111);
            e->size = (uint64_t)st.st_size;
            e->content_fd = cfd;                    /* keep open for emit pass */
            compute_file_sha(cfd, e->sha_hex);
        } else if (S_ISLNK(st.st_mode)) {
            die("reject symlink (should be caught by O_NOFOLLOW): %s", rel);
        } else {
            die("reject non-regular non-dir (dev/socket/fifo): %s", rel);
        }
    }
    closedir(d); /* closes the dup fd */
}

/* ---- canonical digest over the manifest (mirrors snapshot.ts) ----------- */

/* Build JSON.stringify(sorted) where sorted excludes root "" and is sorted by
 * path. Then sha256 the JSON bytes and prefix "sha256:". Caller receives a
 * 65-char "sha256:<hex>" string. */
static void compute_canonical_digest(char out[72]) {
    /* collect pointers (excluding root "") into a scratch array */
    static entry_t *sorted[MAX_ENTRIES];
    uint32_t n = 0;
    for (uint32_t i = 0; i < g_nentries; i++) {
        if (g_entries[i].relpath[0] == '\0') continue;   /* exclude root */
        sorted[n++] = &g_entries[i];
    }
    qsort(sorted, n, sizeof(entry_t*), cmp_entry_ptr);

    buf_t jb = {0};
    buf_putc(&jb, '[');
    for (uint32_t i = 0; i < n; i++) {
        entry_t *e = sorted[i];
        if (i) buf_putc(&jb, ',');
        buf_putc(&jb, '{');
        buf_puts(&jb, "\"path\":");      buf_jsonstr(&jb, e->relpath);
        buf_puts(&jb, ",\"type\":");
        if (e->file_type == 2) buf_puts(&jb, "\"dir\"");
        else                   buf_puts(&jb, "\"file\"");
        char modebuf[16]; snprintf(modebuf, sizeof(modebuf), ",\"mode\":%u", e->mode_exec);
        buf_puts(&jb, modebuf);
        if (e->file_type == 1) {
            buf_puts(&jb, ",\"sha256\":");
            buf_jsonstr(&jb, e->sha_hex);
        }
        buf_putc(&jb, '}');
    }
    buf_putc(&jb, ']');

    sha256_ctx c; sha256_init(&c);
    sha256_update(&c, jb.p ? jb.p : "", jb.len);
    uint8_t d[32]; sha256_final(&c, d);
    char hex[65]; sha256_hex(d, hex);
    snprintf(out, 72, "sha256:%s", hex);
    if (getenv("OCTOPUS_VM_IB_DEBUG")) {
        fprintf(stderr, "C_JSON (%zu bytes): %s\n", jb.len, jb.p ? jb.p : "(null)");
        fprintf(stderr, "C_DIGEST: sha256:%s\n", hex);
    }
    free(jb.p);
}

/* ---- emit directory blocks + file data ----------------------------------- */

static uint32_t inode_of(const char *relpath) {
    for (uint32_t i = 0; i < g_nentries; i++)
        if (strcmp(g_entries[i].relpath, relpath) == 0) return g_entries[i].inode;
    return 0;
}

/* basname of a relpath (after last '/') */
static const char *basname(const char *relpath) {
    const char *s = strrchr(relpath, '/');
    return s ? s + 1 : relpath;
}

static void collect_children(const char *dirrel, entry_t **out, uint32_t *nout, uint32_t cap) {
    uint32_t n = 0;
    size_t dlen = strlen(dirrel);
    for (uint32_t i = 0; i < g_nentries && n < cap; i++) {
        const char *r = g_entries[i].relpath;
        if (r[0] == '\0') continue;   /* root never a child */
        if (dlen == 0) {
            if (strchr(r, '/') == NULL) out[n++] = &g_entries[i];
        } else {
            if (strncmp(r, dirrel, dlen) == 0 && r[dlen] == '/') {
                const char *rest = r + dlen + 1;
                if (strchr(rest, '/') == NULL) out[n++] = &g_entries[i];
            }
        }
    }
    *nout = n;
}

#define MAX_CHILDREN 256

static void write_directory_block(img_t *im, uint32_t dir_inode, const char *dirrel,
                                  uint32_t *out_block_off, uint32_t *out_nblocks) {
    uint8_t blk[BLOCK_SIZE];
    memset(blk, 0, sizeof(blk));
    size_t off = 0;

    /* "." -> self */
    {
        struct ext4_dirent *de = (struct ext4_dirent*)(blk + off);
        de->inode = dir_inode;
        de->name_len = 1;
        de->file_type = 2;
        de->name[0] = '.';
        de->rec_len = 12;            /* 8 header + 1 name + 3 pad */
        off += 12;
    }
    /* ".." -> parent (root's parent is itself) */
    {
        uint32_t parent = ROOT_INO;
        if (dirrel[0]) {
            char parentrel[4096];
            snprintf(parentrel, sizeof(parentrel), "%s", dirrel);
            char *slash = strrchr(parentrel, '/');
            if (slash) *slash = '\0'; else parentrel[0] = '\0';
            parent = parentrel[0] ? inode_of(parentrel) : ROOT_INO;
        }
        struct ext4_dirent *de = (struct ext4_dirent*)(blk + off);
        de->inode = parent;
        de->name_len = 2;
        de->file_type = 2;
        de->name[0] = '.'; de->name[1] = '.';
        de->rec_len = 12;
        off += 12;
    }
    /* children */
    entry_t *children[MAX_CHILDREN];
    uint32_t nch = 0;
    collect_children(dirrel, children, &nch, MAX_CHILDREN);
    for (uint32_t i = 0; i < nch; i++) {
        entry_t *c = children[i];
        const char *bn = basname(c->relpath);
        size_t nl = strlen(bn);
        size_t need = 8 + nl;
        need = (need + 3) & ~3u;      /* 4-byte align */
        if (off + need > BLOCK_SIZE) die("directory block overflow (>1024B) for %s — split not supported", dirrel);
        struct ext4_dirent *de = (struct ext4_dirent*)(blk + off);
        de->inode = c->inode;
        de->name_len = (uint8_t)nl;
        de->file_type = c->file_type;
        memcpy(de->name, bn, nl);
        de->rec_len = (uint16_t)need;
        off += need;
    }
    /* last dirent rec_len stretches to end of block */
    {
        size_t scan = 0, last = 0;
        while (scan < BLOCK_SIZE) {
            struct ext4_dirent *de = (struct ext4_dirent*)(blk + scan);
            if (de->rec_len == 0) break;
            last = scan;
            scan += de->rec_len;
        }
        if (last < BLOCK_SIZE) {
            struct ext4_dirent *de = (struct ext4_dirent*)(blk + last);
            de->rec_len = (uint16_t)(BLOCK_SIZE - last);
        }
    }

    uint64_t boff = alloc_block(im);
    xwrite_at(im, boff, blk, BLOCK_SIZE);
    *out_block_off = (uint32_t)boff;
    *out_nblocks = 1;
}

static void write_file_data(img_t *im, entry_t *e, uint32_t *out_block_off, uint32_t *out_nblocks) {
    uint32_t nblocks = (uint32_t)((e->size + BLOCK_SIZE - 1) / BLOCK_SIZE);
    if (nblocks == 0) nblocks = 1;            /* at least one block for empty file */
    if (nblocks > 12) die("file too large for direct blocks (>12 blocks): %s", e->relpath);
    uint64_t first = alloc_block(im);
    uint8_t buf[BLOCK_SIZE];
    uint64_t remaining = e->size;
    uint64_t cur = first;
    while (1) {
        size_t want = remaining < BLOCK_SIZE ? (size_t)remaining : BLOCK_SIZE;
        memset(buf, 0, sizeof(buf));
        if (want > 0) xread_all(e->content_fd, buf, want);
        xwrite_at(im, cur, buf, BLOCK_SIZE);
        cur += BLOCK_SIZE;
        if (remaining == 0) break;
        remaining -= want;
    }
    if (lseek(e->content_fd, 0, SEEK_SET) == (off_t)-1) die("lseek file back for next pass");
    *out_block_off = (uint32_t)first;
    *out_nblocks = nblocks;
}

/* ---- seal + digest utilities --------------------------------------------- */

static int open_sealed(const char *outPath) {
    /* O_RDWR (not O_WRONLY): seal_and_digest() reads the same fd back to
     * compute the byte digest. A write-only fd returns EBADF on read();
     * fchmod(0444) sets the file's mode but does not change the access
     * mode of the already-open fd, so the fd must be opened read+write. */
    int fd = open(outPath, O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (fd < 0) die("open output (O_EXCL) — exists already?");
    return fd;
}

static void seal_and_digest(img_t *im, uint8_t img_digest_out[32]) {
    if (fsync(im->fd) < 0) die("fsync output");
    if (fchmod(im->fd, 0444) < 0) die("fchmod 0444");
    if (lseek(im->fd, 0, SEEK_SET) == (off_t)-1) die("lseek for byte digest");
    sha256_ctx c; sha256_init(&c);
    uint8_t buf[65536];
    for (;;) {
        ssize_t n = read(im->fd, buf, sizeof(buf));
        if (n < 0) { if (errno == EINTR) continue; die("read image for digest"); }
        if (n == 0) break;
        sha256_update(&c, buf, (size_t)n);
    }
    sha256_final(&c, img_digest_out);
    if (close(im->fd) < 0) die("close output");
}

static void parse_digest(const char *s, char hexout[65]) {
    const char *p = s;
    if (strncmp(s, "sha256:", 7) == 0) p = s + 7;
    if (strlen(p) != 64) die("expected 64-hex digest, got: %s", s);
    for (int i = 0; i < 64; i++) {
        char c = p[i];
        if (!((c>='0'&&c<='9')||(c>='a'&&c<='f')||(c>='A'&&c<='F'))) die("non-hex digest char");
        hexout[i] = (c>='A'&&c<='F') ? (char)(c+32) : c;
    }
    hexout[64] = '\0';
}

/* ---- main ---------------------------------------------------------------- */

int main(int argc, char **argv) {
    if (argc < 2) die("usage: vm-image-builder snapshot|single-file ...");

    if (strcmp(argv[1], "single-file") == 0) {
        if (argc != 6) die("usage: single-file <srcPath> <guestName> <expectedDigest> <outPath>");
        const char *src = argv[2];
        const char *guestName = argv[3];
        char expected[65]; parse_digest(argv[4], expected);
        const char *outPath = argv[5];
        g_outPath = outPath;

        int sfd = open(src, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
        if (sfd < 0) {
            if (errno == ELOOP) die("reject symlink source (single-file)");
            die("open source (single-file)");
        }
        struct stat st;
        if (fstat(sfd, &st) < 0) die("fstat source");
        if (!S_ISREG(st.st_mode)) die("source not a regular file");
        if (st.st_nlink > 1) die("reject hardlink (st_nlink>1)");

        /* recompute digest over the file bytes via the SAME fd */
        sha256_ctx c; sha256_init(&c);
        uint8_t buf[65536];
        for (;;) {
            ssize_t n = read(sfd, buf, sizeof(buf));
            if (n < 0) { if (errno == EINTR) continue; die("read source"); }
            if (n == 0) break;
            sha256_update(&c, buf, (size_t)n);
        }
        uint8_t d[32]; sha256_final(&c, d);
        char hex[65]; sha256_hex(d, hex);
        if (strcmp(hex, expected) != 0)
            die("file digest mismatch: computed %s != expected %s (fail closed)", hex, expected);

        int ofd = open_sealed(outPath);
        img_t im = { .fd = ofd, .cursor = (uint64_t)DATA_FIRST * BLOCK_SIZE };

        /* root dir block (inode 2) with one child: <guestName> -> inode 11 */
        uint8_t rootblk[BLOCK_SIZE];
        memset(rootblk, 0, sizeof(rootblk));
        size_t off = 0;
        {
            struct ext4_dirent *de = (struct ext4_dirent*)(rootblk+off);
            de->inode = ROOT_INO; de->name_len = 1; de->file_type = 2;
            de->name[0] = '.'; de->rec_len = 12; off += 12;
        }
        {
            struct ext4_dirent *de = (struct ext4_dirent*)(rootblk+off);
            de->inode = ROOT_INO; de->name_len = 2; de->file_type = 2;
            de->name[0] = '.'; de->name[1] = '.'; de->rec_len = 12; off += 12;
        }
        size_t nl = strlen(guestName);
        size_t need = (8 + nl + 3) & ~3u;
        if (off + need > BLOCK_SIZE) die("guest name too long for root dir block");
        {
            struct ext4_dirent *de = (struct ext4_dirent*)(rootblk+off);
            de->inode = FIRST_USR_INO; de->name_len = (uint8_t)nl; de->file_type = 1;
            memcpy(de->name, guestName, nl);
            de->rec_len = (uint16_t)(BLOCK_SIZE - off);   /* last entry stretches */
        }
        uint64_t root_off = alloc_block(&im);
        xwrite_at(&im, root_off, rootblk, BLOCK_SIZE);

        /* file data block(s) */
        uint64_t fsize = (uint64_t)st.st_size;
        uint32_t fnblocks = (uint32_t)((fsize + BLOCK_SIZE - 1) / BLOCK_SIZE);
        if (fnblocks == 0) fnblocks = 1;
        if (fnblocks > 12) die("file too large for direct blocks");
        uint64_t fdata = alloc_block(&im);
        if (lseek(sfd, 0, SEEK_SET) == (off_t)-1) die("lseek source back");
        {
            uint8_t fbuf[BLOCK_SIZE];
            uint64_t rem = fsize; uint64_t cur = fdata;
            while (1) {
                size_t want = rem < BLOCK_SIZE ? (size_t)rem : BLOCK_SIZE;
                memset(fbuf, 0, sizeof(fbuf));
                if (want > 0) xread_all(sfd, fbuf, want);
                xwrite_at(&im, cur, fbuf, BLOCK_SIZE);
                cur += BLOCK_SIZE;
                if (rem == 0) break;
                rem -= want;
            }
        }
        close(sfd);

        uint32_t total_blocks = (uint32_t)(im.cursor / BLOCK_SIZE);

        struct ext4_inode root_ino; memset(&root_ino, 0, sizeof(root_ino));
        root_ino.i_mode = 0040755;
        root_ino.i_size_lo = BLOCK_SIZE;
        root_ino.i_links_count = 2;
        root_ino.i_block[0] = (uint32_t)(root_off / BLOCK_SIZE);
        root_ino.i_blocks_lo = (BLOCK_SIZE / 512);
        write_inode(&im, ROOT_INO, &root_ino);

        struct ext4_inode file_ino; memset(&file_ino, 0, sizeof(file_ino));
        file_ino.i_mode = 0100444;
        file_ino.i_size_lo = (uint32_t)fsize;
        file_ino.i_links_count = 1;
        file_ino.i_block[0] = (uint32_t)(fdata / BLOCK_SIZE);
        file_ino.i_blocks_lo = (uint32_t)(fnblocks * (BLOCK_SIZE / 512));
        write_inode(&im, FIRST_USR_INO, &file_ino);

        uint32_t highest_block = (total_blocks - 1);
        write_bitmaps(&im, highest_block, FIRST_USR_INO);
        write_gdt(&im, total_blocks - DATA_FIRST - (total_blocks - DATA_FIRST),
                  N_INODES - FIRST_USR_INO, 1);
        write_superblock(&im, total_blocks,
                         (8 * BLOCK_SIZE) - total_blocks,   /* per-group free */
                         N_INODES - FIRST_USR_INO, 1);

        uint8_t imgd[32]; seal_and_digest(&im, imgd);
        char imghex[65]; sha256_hex(imgd, imghex);
        fprintf(stdout, "sha256:%s\n", imghex);
        return 0;
    }

    if (strcmp(argv[1], "snapshot") == 0) {
        if (argc != 5) die("usage: snapshot <srcDir> <expectedDigest> <outPath>");
        const char *srcDir = argv[2];
        char expected[65]; parse_digest(argv[3], expected);
        const char *outPath = argv[4];
        g_outPath = outPath;

        int rootfd = open(srcDir, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
        if (rootfd < 0) die("open source dir");
        struct stat rst;
        if (fstat(rootfd, &rst) < 0) die("fstat source dir");
        if (!S_ISDIR(rst.st_mode)) die("source not a directory");
        g_root_dev = rst.st_dev;
        visited_add(rst.st_dev, rst.st_ino);

        /* root entry (relpath "") is inode 2; excluded from the manifest digest. */
        entry_t *root = new_entry("", 2);
        root->mode_exec = (uint32_t)(rst.st_mode & 0111);

        walk(rootfd, "", 0);
        close(rootfd);

        char computed[72];
        compute_canonical_digest(computed);
        char computed_hex[65];
        parse_digest(computed, computed_hex);
        if (strcmp(computed_hex, expected) != 0)
            die("snapshot digest mismatch: computed %s != expected %s (fail closed)",
                computed, expected);

        int ofd = open_sealed(outPath);
        img_t im = { .fd = ofd, .cursor = (uint64_t)DATA_FIRST * BLOCK_SIZE };

        /* allocate data blocks (dirs + files) and record offsets */
        qsort(g_entries, g_nentries, sizeof(entry_t), cmp_entry_struct);

        /* count subdirs per directory for link-count accounting */
        for (uint32_t i = 0; i < g_nentries; i++) {
            if (g_entries[i].file_type != 2) continue;
            const char *dirrel = g_entries[i].relpath;
            entry_t *children[MAX_CHILDREN];
            uint32_t nch = 0;
            collect_children(dirrel, children, &nch, MAX_CHILDREN);
            for (uint32_t k = 0; k < nch; k++)
                if (children[k]->file_type == 2) g_entries[i].n_subdirs++;
        }

        for (uint32_t i = 0; i < g_nentries; i++) {
            entry_t *e = &g_entries[i];
            if (e->file_type == 2)
                write_directory_block(&im, e->inode, e->relpath,
                                      (uint32_t*)&e->data_block_off, &e->data_blocks);
            else
                write_file_data(&im, e, (uint32_t*)&e->data_block_off, &e->data_blocks);
        }

        uint32_t total_blocks = (uint32_t)(im.cursor / BLOCK_SIZE);

        /* write all inodes */
        uint32_t highest_inode = 0;
        for (uint32_t i = 0; i < g_nentries; i++) {
            entry_t *e = &g_entries[i];
            struct ext4_inode ino; memset(&ino, 0, sizeof(ino));
            if (e->file_type == 2) {
                ino.i_mode = 0040755;
                ino.i_size_lo = BLOCK_SIZE;
                ino.i_links_count = (uint16_t)(2 + e->n_subdirs);
            } else {
                ino.i_mode = 0100444;
                ino.i_size_lo = (uint32_t)e->size;
                ino.i_links_count = 1;
            }
            ino.i_block[0] = (uint32_t)(e->data_block_off / BLOCK_SIZE);
            ino.i_blocks_lo = (uint32_t)(e->data_blocks * (BLOCK_SIZE / 512));
            write_inode(&im, e->inode, &ino);
            if (e->inode > highest_inode) highest_inode = e->inode;
            if (e->content_fd >= 0) { close(e->content_fd); e->content_fd = -1; }
        }

        uint32_t used_data_blocks = total_blocks - DATA_FIRST;
        uint32_t highest_block = (total_blocks - 1);
        uint32_t num_dirs = 0;
        for (uint32_t i = 0; i < g_nentries; i++) if (g_entries[i].file_type == 2) num_dirs++;

        write_bitmaps(&im, highest_block, highest_inode);
        write_gdt(&im, (8 * BLOCK_SIZE) - used_data_blocks, N_INODES - highest_inode, num_dirs);
        write_superblock(&im, total_blocks,
                         (8 * BLOCK_SIZE) - used_data_blocks,
                         N_INODES - highest_inode, num_dirs);

        uint8_t imgd[32]; seal_and_digest(&im, imgd);
        char imghex[65]; sha256_hex(imgd, imghex);
        fprintf(stdout, "sha256:%s\n", imghex);
        return 0;
    }

    die("unknown mode: %s (expected snapshot|single-file)", argv[1]);
    return 1;
}
