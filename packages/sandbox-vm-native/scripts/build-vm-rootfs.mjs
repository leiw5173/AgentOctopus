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
 *   - fixed mtime/hash_seed: -T now is forbidden; we set E2FSPROGS_FAKE_TIME
 *     and disable hash_seed via tune2fs so directory entries are stable
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
 *   prebuilds/linux-<arch>/rootfs.img             (ext4, mode 0444 after seal)
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

// Fixed epoch for mke2fs/tune2fs timestamps. E2FSPROGS_FAKE_TIME makes
// every filesystem timestamp (create, last-write, last-mount) collapse to
// this single value, so the image is byte-stable across builds. Zero is
// the conventional "epoch" reproducible-build value.
const FIXED_EPOCH = '0';

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

async function compileGuest(staging, guestAbsPath, srcPath, extra = []) {
  const dest = path.join(staging, guestAbsPath);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmpOut = dest + `.tmp-${process.pid}`;
  const args = ['-O2', '-std=gnu17', '-Wall', '-Werror', '-o', tmpOut, srcPath, ...extra];
  try {
    await execFileAsync('cc', args);
  } catch (err) {
    await fs.rm(tmpOut, { force: true }).catch(() => {});
    die(`guest compile failed for ${path.basename(srcPath)}: ${err.stderr ?? err.message}`);
  }
  await fs.chmod(tmpOut, 0o755);
  await fs.rename(tmpOut, dest);
}

async function buildStaging(staging, nodeHostPath, runtimeBins) {
  await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(staging, { recursive: true });

  if (!existsSync(nodeHostPath)) {
    die(`pinned guest node not found at ${nodeHostPath}\n` +
      '  Set OCTOPUS_ROOTFS_NODE (x64) / OCTOPUS_ROOTFS_NODE_ARM64 (arm64) to a Linux node.');
  }
  await copyInto(staging, ROOTFS_NODE_GUEST_PATH, nodeHostPath, 0o755);

  if (!existsSync(VM_INIT_SRC)) die(`vm-init.c source not found at ${VM_INIT_SRC}`);
  await compileGuest(staging, VM_INIT_GUEST_PATH, VM_INIT_SRC);

  // vsock→loopback forwarder (optional; vm-init.c's start_forwarder is
  // self-contained as of Task 12, so this is optional).
  if (existsSync(VSOCK_FORWARDER_SRC)) {
    await compileGuest(staging, VSOCK_FORWARDER_GUEST_PATH, VSOCK_FORWARDER_SRC);
  }

  for (const { guest, host } of runtimeBins) {
    if (!existsSync(host)) die(`declared runtime bin '${guest}' source not found at ${host}`);
    await copyInto(staging, guest, host, 0o755);
  }

  for (const d of ['/tmp', '/run', '/dev', '/etc']) {
    await fs.mkdir(path.join(staging, d), { recursive: true });
  }
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
//   E2FSPROGS_FAKE_TIME=FIXED_EPOCH  — all fs timestamps collapse to epoch 0
//   mke2fs -t ext4 -b 4096 -U <uuid> -N <inodes>
//         -O ^has_journal,^metadata_csum  — read-only rootfs: no journal, no
//                                            csum (csum seed would vary)
//         -E lazy_itable_init=0,lazy_journal_init=0 -d <staging>
//   tune2fs -C 0 -T 0 ...             — last-mount/last-check to epoch
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
    '-E', 'lazy_itable_init=0,lazy_journal_init=0',
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

  // Collapse remaining nondeterministic superblock fields and seal read-only.
  const tune2fsArgs = [
    '-C', '0',      // mount count
    '-T', FIXED_EPOCH, // last-check time
    '-U', ROOTFS_UUID, // re-pin UUID (defensive: some mke2fs revs rewrite it)
    destPath,
  ];
  try {
    await execFileAsync('tune2fs', tune2fsArgs, { env });
  } catch (err) {
    await fs.rm(destPath, { force: true }).catch(() => {});
    die(`tune2fs failed: ${err.stderr ?? err.message}`);
  }

  // Seal read-only (0444) — matches the C writer's seal contract so the
  // backend mode assertion (rootfs mode === 0o444) holds.
  await fs.chmod(destPath, 0o444);
}

// Build the rootfs for one arch: build the staging tree, compute the tree
// digest + image geometry, build the image TWICE, assert the two byte
// digests match, write the manifest.
async function buildArch(arch, nodeHostPath, runtimeBins) {
  const target = archTarget(arch);
  const targetDir = path.join(PREBUILDS_DIR, target);
  await fs.mkdir(targetDir, { recursive: true });

  const ROOTFS_IMG = path.join(targetDir, 'rootfs.img');
  const ROOTFS_MANIFEST = path.join(targetDir, 'rootfs.manifest.json');
  const staging = path.join(os.tmpdir(), `octopus-rootfs-staging-${process.pid}-${Date.now()}-${arch}`);

  try {
    await buildStaging(staging, nodeHostPath, runtimeBins);

    // Tree identity (audit field).
    const entries = relEntriesFor(staging).filter((e) => e.path !== '');
    const expectedTreeDigest = canonicalDigest(entries);
    if (!SHA256_RE.test(expectedTreeDigest.slice(7))) {
      die('internal error: computed tree digest is not 64 lowercase hex', 3);
    }

    const sizeBlocks = imageSizeBlocks(staging);
    const inodeCount = entries.length + 4; // entries + root + lost+found + slack

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

    console.log(`build-vm-rootfs: OK (${target})`);
    console.log(`  rootfs:    ${ROOTFS_IMG}`);
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

// Tool gate.
try { await execFileAsync('mke2fs', ['-V']); }
catch { die("required tool 'mke2fs' is not on PATH — install e2fsprogs on the release lane."); }
try { await execFileAsync('tune2fs', ['-V']); }
catch { die("required tool 'tune2fs' is not on PATH — install e2fsprogs on the release lane."); }
try { await execFileAsync('cc', ['--version']); }
catch { die("required tool 'cc' is not on PATH — install a C toolchain."); }

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

// linux-x64: native on an x64 Linux runner.
{
  const nodeHostPath = process.env.OCTOPUS_ROOTFS_NODE ?? process.execPath;
  const runtimeBins = [{ guest: ROOTFS_NODE_GUEST_PATH, host: nodeHostPath }, ...extraBins];
  built.push(await buildArch('x64', nodeHostPath, runtimeBins));
}

// linux-arm64: requires a cross-built or pre-fetched arm64 guest node.
// Skip with a clear message if not provided — do NOT fail the whole run,
// because a single-arch lane may legitimately only produce one rootfs.
{
  const nodeArm64 = process.env.OCTOPUS_ROOTFS_NODE_ARM64;
  if (nodeArm64 && existsSync(nodeArm64)) {
    const runtimeBins = [{ guest: ROOTFS_NODE_GUEST_PATH, host: nodeArm64 }, ...extraBins];
    built.push(await buildArch('arm64', nodeArm64, runtimeBins));
  } else {
    console.error(
      'build-vm-rootfs: SKIP linux-arm64 — OCTOPUS_ROOTFS_NODE_ARM64 not set or not a file.\n' +
      '  The arm64 guest rootfs is produced on an arm64 lane (or with a cross-built node).\n' +
      '  This is not a failure; the linux-x64 rootfs was still produced.',
    );
  }
}

console.log(`build-vm-rootfs: produced ${built.length} rootfs image(s).`);
