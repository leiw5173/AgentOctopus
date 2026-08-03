#!/usr/bin/env node
/**
 * build-vm-rootfs.mjs — producer for the sealed read-only ext4 VM rootfs.
 *
 * === CORRECTION (2026-07-30, user ruling on Task 15 open Q1) ===
 * The original brief handed the rootfs staging tree to the hand-written C
 * `vm-image-builder` ext4 writer (Task 13). That writer is intentionally
 * minimal — single block group, ~8 MiB total / 12 KiB per file (only direct
 * blocks implemented; indirect/double/triple i_block slots exist but are
 * unused, vm-image-builder.c:694). A real guest needs a ~30 MiB Linux `node`
 * binary plus the ~14 KiB vm-init, so the C writer dies at CI runtime.
 *
 * Resolution: vm-image-builder.c is NOT extended. It stays scoped to Task
 * 13's small skill block images (8 MiB / 12 KiB limits documented as
 * deliberate, M1 carried). The rootfs is produced with STANDARD ext4
 * tooling — a pinned-version `mke2fs` (e2fsprogs) — on the Linux release
 * lane. Reproducibility is enforced by:
 *   - fixed UUID (-U <uuid>)
 *   - fixed capacity algorithm (-b 4096, sized from the staging tree)
 *   - fixed mtime/atime: the staging tree is pinned to the fixed epoch and
 *     E2FSPROGS_FAKE_TIME makes mke2fs fake the mkfs-assigned times; the one
 *     volatile inode field it does NOT fake (ctime) is pinned post-build via
 *     debugfs. hash_seed is pinned via mke2fs -E hash_seed=<uuid>.
 *   - NO tune2fs: it re-bumps s_wtime to the wall clock even under
 *     E2FSPROGS_FAKE_TIME, and mke2fs already sets mount count 0 + the UUID.
 *   - fixed inode params (-N <count> so inode table size is deterministic)
 *   - journal DISABLED (-O ^has_journal) — read-only rootfs, no journal
 *   - lazy init DISABLED (-E lazy_itable_init=0,lazy_journal_init=0)
 *   - CI builds the image TWICE and asserts byte-identical SHA-256 between
 *     the two builds; any divergence fails the lane.
 *
 * The script produces TWO guest rootfs images, one per target arch, because
 * the guest `node` binary is arch-specific: prebuilds/linux-arm64/rootfs.img
 * and prebuilds/linux-x64/rootfs.img. (The host lane is Linux; on a Linux
 * x64 runner we can only natively build the linux-x64 guest node. The
 * linux-arm64 guest node is cross-built or fetched per the arch's CI step
 * and pointed at via OCTOPUS_ROOTFS_NODE_ARM64. If absent, that arch is
 * skipped with a clear message rather than failing the whole run.)
 *
 * Output (per arch):
 *   prebuilds/linux-<arch>/rootfs.img             (ext4, mode 0444 after seal;
 *                                                  consumed by run-vm-gates.mjs)
 *   prebuilds/linux-<arch>/rootfs/<ref>           (identical sealed bytes under
 *                                                  the ref filename — consumed
 *                                                  by engine.resolveRootfs at
 *                                                  launch time)
 *   prebuilds/linux-<arch>/rootfs.manifest.json    ({schemaVersion, ref, ...})
 *
 * `ref` is `sha256:<64hex>` over the .img bytes — the block-image byte
 * identity consumed by gate-manifest.ts qualifiedRootfsDigests[] (Task 16).
 * `manifestDigest` records the staging-tree identity (canonical snapshot
 * digest, same algorithm as vm-image-builder.c compute_canonical_digest)
 * for audit; the C builder's fail-closed copy-time assertion is replaced
 * here by the double-build SHA-256 match assertion.
 *
 * FAIL-CLOSED on non-Linux hosts. This is a Linux release-lane producer:
 * mke2fs is a Linux tool, the guest node is a Linux binary, and the result
 * must be verified against the pinned guest identity. macOS cannot produce
 * a trustworthy Linux rootfs. Do NOT soften this — there is no "best
 * effort" rootfs.
 *
 * Fail-closed everywhere: missing tool/input/binary exits non-zero; no
 * partial artifact is ever left in place.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, createReadStream } from 'node:fs';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const SRC_DIR = path.join(PKG_ROOT, 'src');
const PREBUILDS_DIR = path.join(PKG_ROOT, 'prebuilds');

const SHA256_RE = /^[0-9a-f]{64}$/;

// The guest bootstrap PID 1 (Task 12). Installed at this absolute path
// inside the rootfs; vm-init.c opens the virtio control console, decodes the
// launch spec, and execve's the requested executable.
const VM_INIT_SRC = path.join(SRC_DIR, 'vm-init.c');
const VM_INIT_GUEST_PATH = '/usr/libexec/octopus-vm-init';

// Pinned guest node. The rootfs must contain a real, fixed node at the
// osRuntime.nodePath location (schema.ts) so the guest can resolve `node`
// via the executable map. The build copies a host node into staging at
// /usr/bin/node. Override via env for CI lane reproducibility (CI pins a
// specific node and points OCTOPUS_ROOTFS_NODE(_ARM64) at it).
const ROOTFS_NODE_GUEST_PATH = '/usr/bin/node';
const VSOCK_FORWARDER_SRC = path.join(SRC_DIR, 'vm-vsock-forwarder.c');
const VSOCK_FORWARDER_GUEST_PATH = '/usr/libexec/octopus-vsock-forwarder';

// Fixed UUID for the rootfs ext4 image. Pinned so the superblock is
// byte-identical across reproducible builds. Generated once, committed here.
const ROOTFS_UUID = '8a3f0c2e-1b4d-4f7a-9c6e-2d8b1a5f4e3a';

// Fixed epoch for the mke2fs timestamps. E2FSPROGS_FAKE_TIME makes every
// filesystem timestamp (create, last-write, last-mount, last-check) collapse
// to this single value, so the image is byte-stable across builds. It must be
// NON-ZERO: e2fsprogs treats E2FSPROGS_FAKE_TIME=0 as unset (0 is falsy) and
// silently falls back to the real wall-clock time, so '0' produced
// NON-deterministic images. '1' (one second past the epoch) is the smallest
// value that actually engages the fake clock.
const FIXED_EPOCH = '1';

function die(msg, exitCode = 1) {
  console.error(`build-vm-rootfs: ERROR: ${msg}`);
  process.exit(exitCode);
}

function assertLinux() {
  if (process.platform !== 'linux') {
    die(
      `unsupported host platform '${process.platform}' — rootfs is produced ` +
      `on the Linux release lane only. The VM rootfs carries a Linux node + ` +
      `Linux bootstrap, is built with Linux mke2fs, and is verified against ` +
      `the pinned guest identity; building it on a non-Linux host cannot ` +
      `produce a trustworthy image.`,
    );
  }
}

function archTarget(arch) {
  // Guest arches the rootfs targets. The host lane is Linux; an x64 runner
  // builds linux-x64 natively. linux-arm64 requires a cross-built or
  // pre-fetched guest node pointed at via OCTOPUS_ROOTFS_NODE_ARM64.
  if (arch === 'arm64') return 'linux-arm64';
  if (arch === 'x64') return 'linux-x64';
  die(`unsupported guest arch '${arch}' — rootfs targets linux-arm64 and linux-x64 only.`);
}

// Guest binaries (vm-init, vsock-forwarder) are statically linked AND built
// for the guest CPU arch — (for linux-arm64) a different ISA than the x64
// build host. Static keeps them independent of the bundled loader/libc: they
// run before and alongside the workload and are TCB-critical, so they must
// exec even if the node library closure were ever incomplete. The x64 build
// uses the host compiler; the arm64 build needs the aarch64 cross toolchain
// (gcc-aarch64-linux-gnu), provisioned by the producer CI step.
function guestCompiler(arch) {
  if (arch === 'arm64') return 'aarch64-linux-gnu-gcc';
  if (arch === 'x64') return 'cc';
  die(`unsupported guest arch '${arch}' — cannot select a guest C compiler.`);
}

async function writeAtomic(dest, data) {
  const tmp = path.join(path.dirname(dest), `.tmp-${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, dest);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(p);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Canonical snapshot digest — matches the C vm-image-builder's
// compute_canonical_digest (vm-image-builder.c:541) for the symlink-free
// subset. Recorded as `manifestDigest` for audit; the C builder's
// copy-time fail-closed assertion is replaced here by the double-build
// SHA-256 match (the rootfs is built with mke2fs, not the C writer).
//
// JSON entry shape: {path,type,mode[,sha256]} with type in {"dir","file"}.
// Sorting is by `path` byte order (strcmp), matching qsort. Root "" excluded.
// Symlinks / special files / hardlinks are rejected (the rootfs tree is
// symlink-free by construction; mke2fs would materialize symlinks otherwise).
// ---------------------------------------------------------------------------

function relEntriesFor(root, rel = '', out = []) {
  const abs = path.join(root, rel);
  const st = fsSync.lstatSync(abs);
  if (st.isFIFO() || st.isSocket() || st.isCharacterDevice() || st.isBlockDevice()) {
    throw new Error(`special file in staging: ${rel}`);
  }
  if (st.isSymbolicLink()) {
    throw new Error(`symlink in staging: ${rel} (rootfs must be symlink-free)`);
  }
  const nrel = rel.split(path.sep).join('/').normalize('NFC');
  if (st.isDirectory()) {
    if (nrel !== '') out.push({ path: nrel, type: 'dir', mode: st.mode & 0o111 });
    for (const c of fsSync.readdirSync(abs).sort()) {
      relEntriesFor(root, path.join(rel, c), out);
    }
  } else if (st.isFile()) {
    if (st.nlink > 1) throw new Error(`hard link in staging: ${rel}`);
    const bytes = fsSync.readFileSync(abs);
    out.push({ path: nrel, type: 'file', mode: st.mode & 0o111, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return out;
}

// Serialize entries exactly as the C builder's compute_canonical_digest does:
// [{"path":..,"type":"dir"|"file","mode":N[,"sha256":..]},...], sorted by
// path byte order (strcmp), root "" excluded. Fixed key order path→type→mode→sha256.
function canonicalDigest(entries) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const normalized = sorted.map((e) => {
    const o = { path: e.path, type: e.type, mode: e.mode };
    if (e.type === 'file') o.sha256 = e.sha256;
    return o;
  });
  return 'sha256:' + createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

// ---------------------------------------------------------------------------
// Build the staging tree — a plain directory mke2fs will pack into ext4.
// Layout (all paths absolute inside the guest):
//   /usr/bin/node                              <- pinned host node (copy)
//   /lib/ld-...  (or /lib64/ld-... on x64)     <- node's ELF interpreter (copy)
//   /lib/<lib>.so.N...                         <- node's transitive NEEDED
//                                                 closure: libc/libm/
//                                                 libstdc++/libgcc_s... (copy)
//   /usr/libexec/octopus-vm-init               <- guest bootstrap (compile)
//   /usr/libexec/octopus-vsock-forwarder       <- vsock→loopback forwarder
//   /usr/bin/<runtime-bin>...                  <- declared runtime bins (copy)
//   /tmp /run /dev /etc                        <- empty dir skeleton
// ---------------------------------------------------------------------------

async function copyInto(staging, guestAbsPath, hostPath, mode = 0o755) {
  const dest = path.join(staging, guestAbsPath);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(hostPath, dest);
  await fs.chmod(dest, mode);
}

// Read an ELF's PT_INTERP (dynamic loader path) + DT_NEEDED entries via
// readelf (binutils — arch-independent: the host readelf parses foreign-arch
// ELFs fine, which is how the x64 lane reads the arm64 guest node).
async function elfDynamicDeps(elfPath) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync('readelf', ['-l', '-d', elfPath]));
  } catch (err) {
    die(`readelf failed on ${elfPath}: ${err.stderr ?? err.message}\n` +
      '  Ensure binutils (readelf) is installed on the release lane.');
  }
  const interp = stdout.match(/Requesting program interpreter:\s*([^\]]+)\]/);
  const needed = [...stdout.matchAll(/\(NEEDED\)[^\[]*\[([^\]]+)\]/g)].map((m) => m[1]);
  return { interpreter: interp ? interp[1].trim() : null, needed };
}

// Bundle the dynamic loader + shared libraries a dynamically-linked guest
// node needs. The sealed rootfs previously shipped NO loader or libc, so the
// guest kernel's execve of /usr/bin/node failed ENOENT (missing PT_INTERP)
// and no workload could ever run — G1/G2 could never GO. The set is
// discovered from the node binary itself (readelf) and copied from a
// guest-arch library directory CI provides (OCTOPUS_ROOTFS_LIBS for x64,
// OCTOPUS_ROOTFS_LIBS_ARM64 for arm64 — on the Linux producer lane these are
// the host multiarch dir and the aarch64 cross-toolchain dir respectively;
// both are pinned by the lane's apt provisioning). Fail-closed: a dynamic
// node with no libs dir is a build error, never a loaderless rootfs.
//
// Placement: the interpreter is copied to the EXACT absolute path baked into
// the node binary (e.g. /lib64/ld-linux-x86-64.so.2 on x64,
// /lib/ld-linux-aarch64.so.1 on arm64) — the kernel opens that verbatim.
// NEEDED libraries land in /lib/<name>, which is in every glibc build's
// default search path (Debian/Ubuntu ld.so also searches the multiarch dirs
// and /usr/lib; /lib is the portable common denominator). Staging stays
// symlink-free (real file copies) per the canonical-digest contract.
async function bundleDynamicLibs(staging, nodeHostPath, libsDir) {
  const { interpreter, needed } = await elfDynamicDeps(nodeHostPath);
  if (!interpreter && needed.length === 0) {
    console.log('build-vm-rootfs: guest node is statically linked — no runtime libraries bundled.');
    return [];
  }
  if (!libsDir) {
    die(`guest node is dynamically linked (interpreter=${interpreter ?? 'none'}; ` +
      `NEEDED=${needed.join(',') || 'none'}) but no guest-arch library directory was provided.\n` +
      '  Set OCTOPUS_ROOTFS_LIBS (x64) / OCTOPUS_ROOTFS_LIBS_ARM64 (arm64) to a directory ' +
      'holding the guest ld/libc/libm/libstdc++/libgcc_s shared objects.');
  }
  if (interpreter) {
    const src = path.join(libsDir, path.basename(interpreter));
    if (!existsSync(src)) {
      die(`guest ELF interpreter '${path.basename(interpreter)}' not found in ${libsDir} ` +
        `(node bakes the loader path '${interpreter}').`);
    }
    await copyInto(staging, interpreter, src, 0o755);
  }
  // BFS the NEEDED closure (each library's own DT_NEEDED pulls the next).
  const queue = [...needed];
  const copied = [];
  const seen = new Set(interpreter ? [path.basename(interpreter)] : []);
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const src = path.join(libsDir, name);
    if (!existsSync(src)) {
      die(`guest runtime library '${name}' not found in ${libsDir}\n` +
        '  It is transitively required by the guest node binary. Provide it ' +
        'in the libs directory (CI: apt cross packages for arm64, the host ' +
        'multiarch dir for x64).');
    }
    await copyInto(staging, `/lib/${name}`, src, 0o755);
    copied.push(name);
    const deps = await elfDynamicDeps(src);
    queue.push(...deps.needed);
  }
  console.log(`build-vm-rootfs: bundled interpreter ${interpreter ?? '(none)'} + ` +
    `${copied.length} runtime librar${copied.length === 1 ? 'y' : 'ies'} into /lib: ${copied.join(', ')}`);
  return copied;
}

async function compileGuest(staging, guestAbsPath, srcPath, arch, extra = []) {
  const dest = path.join(staging, guestAbsPath);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmpOut = dest + `.tmp-${process.pid}`;
  const cc = guestCompiler(arch);
  // -static: keep the TCB-critical guest binaries independent of the bundled
  // loader/libc (they must exec even if the node library closure were ever
  // incomplete). Without it an x64 host `cc` also produces a dynamically-
  // linked ELF targeting the HOST loader path, which needlessly couples the
  // bootstrap to the node library set.
  const args = ['-O2', '-static', '-std=gnu17', '-Wall', '-Werror', '-o', tmpOut, srcPath, ...extra];
  try {
    await execFileAsync(cc, args);
  } catch (err) {
    await fs.rm(tmpOut, { force: true }).catch(() => {});
    die(`guest compile failed for ${path.basename(srcPath)} (${arch}, ${cc}): ${err.stderr ?? err.message}`);
  }
  await fs.chmod(tmpOut, 0o755);
  await fs.rename(tmpOut, dest);
}

// Pin every staging entry's atime + mtime to the fixed epoch. mke2fs -d copies
// each source file's atime into the image inode; on hosts without noatime,
// relatime bumps a directory's atime to wall-clock the moment it is readdir'd
// (the pinned atime is <= its mtime, which is exactly the relatime trigger), so
// any read of the staging tree after pinning would be packed with a drifted
// atime and the digests would diverge across runs. Two rules make this hold:
//   (1) POST-ORDER: within the walk a directory is utimes'd only AFTER its
//       children are processed — its own readdir must not come after its utimes.
//   (2) LAST-TOUCH: the pin runs AFTER the reads that follow it (see buildOnce —
//       mke2fs reads the whole tree, so each buildOnce re-pins right after mke2fs
//       returns, before the next build reads it). ctime/mtime come from the
//       fixed mtime and crtime is forced by E2FSPROGS_FAKE_TIME, but atime is NOT
//       covered by the fake clock — it must be pinned on the staging tree itself,
//       and nothing may read the tree after the final pin.
async function pinStagingTimes(staging) {
  const epoch = new Date(Number(FIXED_EPOCH) * 1000);
  const walk = async (dir) => {
    for (const name of await fs.readdir(dir)) {
      const p = path.join(dir, name);
      const st = await fs.lstat(p);
      if (st.isDirectory()) await walk(p);
      await fs.utimes(p, epoch, epoch); // post-order: after the dir's own readdir
    }
  };
  await walk(staging);
  await fs.utimes(staging, epoch, epoch); // root last, after its readdir above
}

async function buildStaging(staging, nodeHostPath, runtimeBins, arch, libsDir) {
  await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(staging, { recursive: true });

  if (!existsSync(nodeHostPath)) {
    die(`pinned guest node not found at ${nodeHostPath}\n` +
      '  Set OCTOPUS_ROOTFS_NODE (x64) / OCTOPUS_ROOTFS_NODE_ARM64 (arm64) to a Linux node.');
  }
  await copyInto(staging, ROOTFS_NODE_GUEST_PATH, nodeHostPath, 0o755);
  // The official node build is dynamically linked — bundle its interpreter +
  // library closure or the guest cannot exec it (fail-closed inside).
  await bundleDynamicLibs(staging, nodeHostPath, libsDir);

  if (!existsSync(VM_INIT_SRC)) die(`vm-init.c source not found at ${VM_INIT_SRC}`);
  await compileGuest(staging, VM_INIT_GUEST_PATH, VM_INIT_SRC, arch);

  // vsock→loopback forwarder (optional; vm-init.c's start_forwarder is
  // self-contained as of Task 12, so this is optional).
  if (existsSync(VSOCK_FORWARDER_SRC)) {
    await compileGuest(staging, VSOCK_FORWARDER_GUEST_PATH, VSOCK_FORWARDER_SRC, arch);
  }

  for (const { guest, host } of runtimeBins) {
    if (!existsSync(host)) die(`declared runtime bin '${guest}' source not found at ${host}`);
    await copyInto(staging, guest, host, 0o755);
  }

  // Empty dir skeleton. The rootfs is mounted READ-ONLY (sealed image), so
  // every mount point the guest needs must pre-exist here — neither libkrun's
  // init nor vm-init can mkdir on a ro root:
  //   /tmp /run /dev /etc   <- base skeleton (tmpfs / devtmpfs / conf)
  //   /proc                 <- libkrun init_or_kernel mounts procfs here
  //   /sys                  <- vm-init scans /sys/class/virtio-ports (sysfs)
  //   /skill                <- vm-init mounts /dev/vdb (skill block) here
  //   /etc/skill-ca         <- vm-init mounts /dev/vdc (CA block) here
  for (const d of ['/tmp', '/run', '/dev', '/etc', '/proc', '/sys', '/skill', '/etc/skill-ca']) {
    await fs.mkdir(path.join(staging, d), { recursive: true });
  }

  // Pin atime+mtime after all writes so the size/tree reads below start from a
  // stable tree. The DECISIVE pin is the one buildOnce applies right after mke2fs
  // reads the tree (relatime bumps dir atimes on read) — that is the last touch
  // before the next build reads it. See pinStagingTimes.
  await pinStagingTimes(staging);
}

// ---------------------------------------------------------------------------
// Compute the ext4 image size in 4 KiB blocks from the staging tree. The
// algorithm is fixed so the image geometry is deterministic: sum of file
// data blocks + per-entry inode overhead + a fixed metadata reserve, rounded
// up to the next power-of-two number of blocks within a bounded range.
// mke2fs would otherwise pick a size from the file count heuristically and
// the resulting free-block count could vary between builds.
// ---------------------------------------------------------------------------

function imageSizeBlocks(staging) {
  let fileBytes = 0;
  let entryCount = 2; // root + lost+found
  const walk = (dir) => {
    for (const name of fsSync.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fsSync.lstatSync(p);
      entryCount++;
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) fileBytes += st.size;
    }
  };
  walk(staging);
  const fileBlocks = Math.ceil(fileBytes / 4096);
  // inode table: one inode per entry, rounded up to 4 KiB. Plus superblock,
  // GDT, bitmaps, journal-less metadata reserve (8 blocks/1KiB group rounded).
  const inodeBlocks = Math.ceil(entryCount * 256 / 4096);
  const minBlocks = fileBlocks + inodeBlocks + 16;
  // Round up to next multiple of 64 (256 KiB) for a stable, non-noisy size.
  const sizeBlocks = Math.max(64, Math.ceil(minBlocks / 64) * 64);
  return sizeBlocks;
}

// ---------------------------------------------------------------------------
// Build ONE rootfs image via mke2fs. Writes to destPath (an empty file
// pre-sized to sizeBlocks*4096). Reproducibility knobs:
//   E2FSPROGS_FAKE_TIME=FIXED_EPOCH  — all fs timestamps collapse to epoch 1
//   mke2fs -t ext4 -b 4096 -U <uuid> -N <inodes>
//         -O ^has_journal,^metadata_csum,^64bit — read-only rootfs: no journal,
//                                            no csum (csum seed would vary)
//         -E ...,hash_seed=<uuid> -d <staging> — pins the dir_index hash seed
//                                            (else mkfs randomizes the 16-byte
//                                            s_hash_seed and images differ)
//   debugfs set_inode_field <N> ctime <epoch>  — pins the one volatile inode
//                                       field mke2fs does NOT fake (ctime is
//                                       wall-clock). NO tune2fs: it re-bumps
//                                       s_wtime to the wall clock even under
//                                       the fake clock, and mke2fs already set
//                                       mount count 0 + the UUID.
// The image is then chmod 0444 (sealed read-only) — matches the C writer's
// seal contract so the backend's mode assertion (0o444) holds uniformly.
// ---------------------------------------------------------------------------

async function buildOnce(staging, destPath, sizeBlocks, inodeCount) {
  await fs.rm(destPath, { force: true }).catch(() => {});
  // Pre-create a sparse file of the exact size so mke2fs -E no_copy_xattrs
  // writes into a fixed-size container (deterministic total byte count).
  const fh = await fs.open(destPath, 'w');
  await fh.close();
  await fs.truncate(destPath, sizeBlocks * 4096);

  // Re-pin atime IMMEDIATELY before THIS mke2fs run. On relatime mounts (the
  // default; the CI runner's ext4 is relatime) the FIRST read after a touch
  // bumps atime — so the previous build's mke2fs read already advanced the
  // staging files' atime. Pinning only once (in buildStaging) lets build N+1
  // pack a newer atime than build N. Re-pinning before every build makes both
  // mke2fs runs read the identical pinned atime, so the double-build digests
  // match. (Verified: pin-once diverges on ext4/relatime, re-pin-per-build is
  // byte-identical; tmpfs/noatime masked this in earlier local testing.)
  await pinStagingTimes(staging);

  const env = {
    ...process.env,
    E2FSPROGS_FAKE_TIME: FIXED_EPOCH,
    // libext2fs picks this up; forces deterministic create/mount/write times.
  };
  const mke2fsArgs = [
    '-q',
    '-t', 'ext4',
    '-b', '4096',
    '-U', ROOTFS_UUID,
    '-N', String(inodeCount),
    '-O', '^has_journal,^metadata_csum,^64bit',
    '-E', `lazy_itable_init=0,lazy_journal_init=0,hash_seed=${ROOTFS_UUID}`,
    '-d', staging,
    destPath,
    `${sizeBlocks}`,
  ];
  try {
    await execFileAsync('mke2fs', mke2fsArgs, { env });
  } catch (err) {
    await fs.rm(destPath, { force: true }).catch(() => {});
    die(`mke2fs failed: ${err.stderr ?? err.message}\n` +
      '  Ensure e2fsprogs is installed (pinned version on the release lane).');
  }

  // mke2fs sets every inode's ctime to the wall clock (the one timestamp it
  // does NOT fake under E2FSPROGS_FAKE_TIME, and the one no `touch` can pin —
  // ctime is the inode-metadata-change time, not a file timestamp). Pin every
  // allocated inode's ctime to the fixed epoch with debugfs. We sweep 1..
  // inodeCount: debugfs skips free inodes with a harmless error, so we do not
  // need the exact allocation map. (The superblock's other volatile fields —
  // created/last-check — are already faked to the epoch by mke2fs, and we
  // deliberately do NOT run tune2fs: it unconditionally re-bumps s_wtime to the
  // wall clock even under E2FSPROGS_FAKE_TIME, and mke2fs already sets mount
  // count 0 + the pinned UUID, so tune2fs is pure nondeterminism here.)
  const zapCmds = ['set_inode_field <1> ctime 1'];
  for (let i = 2; i <= inodeCount; i++) zapCmds.push(`set_inode_field <${i}> ctime 1`);
  const zapFile = path.join(os.tmpdir(), `octopus-debugfs-zap-${process.pid}-${Date.now()}.txt`);
  await fs.writeFile(zapFile, zapCmds.join('\n') + '\n');
  try {
    await execFileAsync('debugfs', ['-w', '-f', zapFile, destPath]);
  } catch (err) {
    await fs.rm(zapFile, { force: true }).catch(() => {});
    await fs.rm(destPath, { force: true }).catch(() => {});
    die(`debugfs ctime pin failed: ${err.stderr ?? err.message}`);
  }
  await fs.rm(zapFile, { force: true }).catch(() => {});

  // Seal read-only (0444) — matches the C writer's seal contract so the
  // backend mode assertion (rootfs mode === 0o444) holds.
  await fs.chmod(destPath, 0o444);

  // mke2fs -d just readdir'd the ENTIRE staging tree, which (on hosts without
  // noatime) bumped every directory's atime to wall-clock via relatime. The
  // next buildOnce (or, on the second pass, the promotion below) reads the same
  // tree, so re-pin it NOW — the pin must be the last touch before any
  // subsequent read, or the second image packs a drifted directory atime and
  // cross-run digests diverge. See pinStagingTimes.
  await pinStagingTimes(staging);
}

// Build the rootfs for one arch: build the staging tree, compute the tree
// digest + image geometry, build the image TWICE, assert the two byte
// digests match, write the manifest.
async function buildArch(arch, nodeHostPath, runtimeBins, libsDir) {
  const target = archTarget(arch);
  const targetDir = path.join(PREBUILDS_DIR, target);
  await fs.mkdir(targetDir, { recursive: true });

  const ROOTFS_IMG = path.join(targetDir, 'rootfs.img');
  const ROOTFS_MANIFEST = path.join(targetDir, 'rootfs.manifest.json');
  const staging = path.join(os.tmpdir(), `octopus-rootfs-staging-${process.pid}-${Date.now()}-${arch}`);

  try {
    await buildStaging(staging, nodeHostPath, runtimeBins, arch, libsDir);

    // Tree identity (audit field).
    const entries = relEntriesFor(staging).filter((e) => e.path !== '');
    const expectedTreeDigest = canonicalDigest(entries);
    if (!SHA256_RE.test(expectedTreeDigest.slice(7))) {
      die('internal error: computed tree digest is not 64 lowercase hex', 3);
    }

    const sizeBlocks = imageSizeBlocks(staging);
    // Inode floor: ext4 reserves inodes 1-10 (root is inode 2) and mke2fs takes
    // inode 11 for lost+found, so the staging tree's inodes start at 12. The
    // old `entries + 4` left only `entries - 6` usable inodes — it succeeded
    // only because the tree was tiny, and failed with "Could not allocate
    // inode" the first time a real guest node binary was packed. Reserve the 11
    // structural inodes plus headroom.
    const inodeCount = entries.length + 32; // entries + 10 reserved + lost+found + slack

    // Double-build reproducibility assertion: build into two temp paths,
    // require byte-identical SHA-256. Any nondeterminism (timestamps,
    // journal, hash seed) shows up as a digest divergence.
    const img1 = ROOTFS_IMG + '.build1';
    const img2 = ROOTFS_IMG + '.build2';
    await buildOnce(staging, img1, sizeBlocks, inodeCount);
    await buildOnce(staging, img2, sizeBlocks, inodeCount);
    const sha1 = await sha256File(img1);
    const sha2 = await sha256File(img2);
    if (sha1 !== sha2) {
      await fs.rm(img1, { force: true }).catch(() => {});
      await fs.rm(img2, { force: true }).catch(() => {});
      die(`reproducibility check failed for ${target}: builds diverged\n` +
        `  build1 sha256: ${sha1}\n` +
        `  build2 sha256: ${sha2}\n` +
        `  Rootfs images must be byte-identical across rebuilds. Check for ` +
        `journal/csum/hash-seed/timestamp nondeterminism.`);
    }

    // Promote build1 to the canonical path.
    await fs.rm(ROOTFS_IMG, { force: true }).catch(() => {});
    await fs.rename(img1, ROOTFS_IMG);
    await fs.rm(img2, { force: true }).catch(() => {});

    const rootfsSha = sha1; // == sha2 (asserted)
    const rootfsRef = 'sha256:' + rootfsSha;
    const st = await fs.stat(ROOTFS_IMG);
    if ((st.mode & 0o777) !== 0o444) {
      die(`rootfs.img not sealed read-only (mode ${(st.mode & 0o777).toString(8)}; expected 0444) for ${target}.`);
    }

    const manifest = {
      schemaVersion: 1,
      ref: rootfsRef,
      manifestDigest: expectedTreeDigest,
      sha256: rootfsSha,
      size: st.size,
      mode: st.mode & 0o777,
      platform: target,
      uuid: ROOTFS_UUID,
      guestNode: ROOTFS_NODE_GUEST_PATH,
      guestInit: VM_INIT_GUEST_PATH,
      producer: 'mke2fs',
      mke2fsReproducible: true,
    };
    await writeAtomic(ROOTFS_MANIFEST, JSON.stringify(manifest, null, 2) + '\n');

    // Runtime placement: engine.resolveRootfs() reads the sealed image from
    // prebuilds/<arch>/rootfs/<ref> (engine.ts resolveRootfs joins rootfsDir +
    // the ref verbatim — the ref IS the filename), while run-vm-gates.mjs
    // reads the top-level rootfs.img for qualification. Emit BOTH placements
    // here so every producer (all CI lanes + local builds) yields the layout
    // each consumer resolves, with no workflow-side copying. Preserve the 0444
    // seal on the runtime copy (the backend's rootfs mode assertion requires it).
    const runtimeDir = path.join(targetDir, 'rootfs');
    await fs.mkdir(runtimeDir, { recursive: true });
    const runtimeImg = path.join(runtimeDir, rootfsRef);
    await fs.rm(runtimeImg, { force: true }).catch(() => {});
    await fs.copyFile(ROOTFS_IMG, runtimeImg);
    await fs.chmod(runtimeImg, 0o444);

    console.log(`build-vm-rootfs: OK (${target})`);
    console.log(`  rootfs:    ${ROOTFS_IMG}`);
    console.log(`  runtime:   ${runtimeImg}`);
    console.log(`  manifest:  ${ROOTFS_MANIFEST}`);
    console.log(`  ref:       ${rootfsRef}`);
    console.log(`  tree id:   ${expectedTreeDigest}`);
    console.log(`  size:      ${st.size}`);
    return manifest;
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

assertLinux();

// Probe a required tool by resolving it on PATH — NOT by running a version
// flag. mke2fs -V exits 0, but tune2fs has NO version flag: `tune2fs -V`
// exits 1 ("invalid option -- 'V'"), and execFile rejects on ANY non-zero
// exit, so a run-based probe misreports an INSTALLED tune2fs as "not on PATH"
// (which is how this surfaced on the release lane). Search PATH for an
// executable file instead; uniform across mke2fs/tune2fs/cc.
async function assertOnPath(tool, hint) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, tool);
    try {
      await fs.access(candidate, fsSync.constants.X_OK);
      return candidate;
    } catch { /* not in this dir — keep searching */ }
  }
  die(`required tool '${tool}' is not on PATH — ${hint}`);
}

// Tool gate.
await assertOnPath('mke2fs', 'install e2fsprogs on the release lane.');
await assertOnPath('debugfs', 'install e2fsprogs on the release lane.');
await assertOnPath('cc', 'install a C toolchain.');
await assertOnPath('readelf', 'install binutils on the release lane (reads the guest node ELF interpreter/NEEDED closure).');

// Declared runtime bins (copied verbatim). CI can extend via
// OCTOPUS_ROOTFS_BINS="guest1:host1,guest2:host2".
const extraBinsRaw = process.env.OCTOPUS_ROOTFS_BINS ?? '';
const extraBins = [];
for (const pair of extraBinsRaw.split(',').map((s) => s.trim()).filter(Boolean)) {
  const [guest, host] = pair.split(':');
  if (!guest || !host) die(`bad OCTOPUS_ROOTFS_BINS pair '${pair}' — expected guest:host`);
  extraBins.push({ guest, host });
}

const built = [];

// Guest-arch library directories for the dynamically-linked node binary
// (interpreter + libc/libm/libstdc++/libgcc_s closure). CI sets these:
//   OCTOPUS_ROOTFS_LIBS        x64  (host multiarch dir, e.g. /lib/x86_64-linux-gnu)
//   OCTOPUS_ROOTFS_LIBS_ARM64  arm64 (cross-toolchain dir, /usr/aarch64-linux-gnu/lib)
// A dynamic node without a libs dir fails the build (see bundleDynamicLibs).
const libsX64 = process.env.OCTOPUS_ROOTFS_LIBS;
const libsArm64 = process.env.OCTOPUS_ROOTFS_LIBS_ARM64;

// linux-x64: native on an x64 Linux runner.
{
  const nodeHostPath = process.env.OCTOPUS_ROOTFS_NODE ?? process.execPath;
  const runtimeBins = [{ guest: ROOTFS_NODE_GUEST_PATH, host: nodeHostPath }, ...extraBins];
  built.push(await buildArch('x64', nodeHostPath, runtimeBins, libsX64));
}

// linux-arm64: requires a cross-built or pre-fetched arm64 guest node.
// Skip with a clear message if not provided — do NOT fail the whole run,
// because a single-arch lane may legitimately only produce one rootfs.
{
  const nodeArm64 = process.env.OCTOPUS_ROOTFS_NODE_ARM64;
  if (nodeArm64 && existsSync(nodeArm64)) {
    const runtimeBins = [{ guest: ROOTFS_NODE_GUEST_PATH, host: nodeArm64 }, ...extraBins];
    built.push(await buildArch('arm64', nodeArm64, runtimeBins, libsArm64));
  } else {
    console.error(
      'build-vm-rootfs: SKIP linux-arm64 — OCTOPUS_ROOTFS_NODE_ARM64 not set or not a file.\n' +
      '  The arm64 guest rootfs is produced on an arm64 lane (or with a cross-built node).\n' +
      '  This is not a failure; the linux-x64 rootfs was still produced.',
    );
  }
}

console.log(`build-vm-rootfs: produced ${built.length} rootfs image(s).`);
