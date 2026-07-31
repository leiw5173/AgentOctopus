#!/usr/bin/env node
/**
 * build-runtime-rootfs.mjs — producer for the verified runtime rootfs artifact
 * pair consumed by `verifyRuntimeArtifact()` (packages/sandbox/src/os/rootfs.ts).
 *
 * Produces (gitignored, reproducible from digest-pinned inputs):
 *   runtime/linux-node22.rootfs.tar.zst
 *   runtime/linux-node22.manifest.json
 *
 * Requires a Linux host (or Docker Desktop producing Linux containers) with:
 *   - docker CLI + daemon (to create/export the pinned runtime image's FS)
 *   - tar, zstd on PATH
 *
 * The digest-pinned image ref comes from OCTOPUS_RUNTIME_IMAGE and must match
 * `ImmutableImageRefSchema` (`name@sha256:<64hex>` or bare `sha256:<64hex>`).
 * Plan 6's release lane supplies the pinned value; the config schema's
 * runtime-image default for the OS lane is not yet wired to a concrete image,
 * so this script fails closed when the env var is unset or invalid.
 *
 * Steps (per the Task 2.5 brief):
 *   1. Validate the image ref.
 *   2. docker create --name octn-rootfs-<pid> <image> /bin/true, docker export.
 *   3. Walk the exported tree; record path/kind/mode/size/sha256 for every
 *      entry. Reject symlinks, device nodes, FIFOs, sockets, absolute/`..`
 *      paths, and group/world-writable executables/libraries (same rules as
 *      verifyRuntimeArtifact).
 *   4. Require the node binary, its ELF interpreter, and every DT_NEEDED
 *      library to be present (fail closed).
 *   5. Compute rootfsTreeSha256 (sorted manifest entries) and artifactSha256
 *      (compressed tarball).
 *   6. Write the tar.zst + manifest atomically.
 *   7. Self-check: run the COMPILED verifyRuntimeArtifact() from
 *      ../dist/os/rootfs.js against the just-written pair.
 *   8. docker rm the temporary container in a finally.
 *
 * Fail-closed everywhere: a missing tool/input exits non-zero with an
 * actionable message; no partial artifact is ever left in place.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const RUNTIME_DIR = path.join(PKG_ROOT, 'runtime');
const ARTIFACT_PATH = path.join(RUNTIME_DIR, 'linux-node22.rootfs.tar.zst');
const MANIFEST_PATH = path.join(RUNTIME_DIR, 'linux-node22.manifest.json');
const DIST_ROOTFS = path.join(PKG_ROOT, 'dist', 'os', 'rootfs.js');

const IMAGE_REF_RE = /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@)?sha256:[0-9a-f]{64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function die(msg, exitCode = 1) {
  console.error(`build-runtime-rootfs: ERROR: ${msg}`);
  process.exit(exitCode);
}

async function toolOnPath(tool) {
  try {
    await execFileAsync(tool, ['--version']);
    return true;
  } catch {
    return false;
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

function sha256Buffer(b) {
  return createHash('sha256').update(b).digest('hex');
}

/** Atomic write: tmp file in the same dir + rename. */
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

// ---------------------------------------------------------------------------
// Step 1 — image ref
// ---------------------------------------------------------------------------

const imageRef = process.env.OCTOPUS_RUNTIME_IMAGE;
if (!imageRef) {
  die(
    'OCTOPUS_RUNTIME_IMAGE is not set.\n' +
    '  Set it to the digest-pinned runtime image, e.g.\n' +
    '    OCTOPUS_RUNTIME_IMAGE=node@sha256:<64 lowercase hex> node packages/sandbox/scripts/build-runtime-rootfs.mjs\n' +
    "  Plan 6's release lane supplies the pinned value.",
  );
}
if (!IMAGE_REF_RE.test(imageRef)) {
  die(
    `OCTOPUS_RUNTIME_IMAGE '${imageRef}' is not an immutable digest-pinned ref.\n` +
    '  Expected `name@sha256:<64 lowercase hex>` or bare `sha256:<64 lowercase hex>` (mutable tags are rejected).',
  );
}

// ---------------------------------------------------------------------------
// Tool gates — fail closed before any work
// ---------------------------------------------------------------------------

for (const tool of ['docker', 'tar', 'zstd']) {
  if (!(await toolOnPath(tool))) {
    die(
      `required tool '${tool}' is not on PATH.\n` +
      '  This script needs a Linux host (or Docker Desktop producing Linux containers) with docker, tar, and zstd.\n' +
      '  On this host the artifact cannot be produced; the gated os-rootfs tests will skip and run on the Plan 6 Linux lane.',
    );
  }
}

// ---------------------------------------------------------------------------
// Steps 2–8
// ---------------------------------------------------------------------------

const containerName = `octn-rootfs-${process.pid}`;
let containerCreated = false;
let stagingDir;

async function main() {
  // Step 2: create + export the container FS (entrypoint never runs).
  try {
    await execFileAsync('docker', ['create', '--name', containerName, imageRef, '/bin/true']);
    containerCreated = true;
  } catch (err) {
    die(`docker create failed for image ${imageRef}: ${err.stderr ?? err.message}\n  Is the image pulled? Is the Docker daemon running?`);
  }

  stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oct-rootfs-build-'));
  const exportTar = path.join(stagingDir, 'export.tar');
  const treeDir = path.join(stagingDir, 'tree');
  await fs.mkdir(treeDir, { recursive: true, mode: 0o700 });

  const exported = await execFileAsync('docker', ['export', containerName], {
    encoding: 'buffer',
    maxBuffer: 4 * 1024 * 1024 * 1024,
  }).catch((err) => die(`docker export failed: ${err.stderr?.toString() ?? err.message}`));
  await fs.writeFile(exportTar, exported.stdout);
  await execFileAsync('tar', ['-xf', exportTar, '-C', treeDir, '--no-same-owner', '--no-same-permissions'])
    .catch((err) => die(`tar extraction of exported rootfs failed: ${err.stderr ?? err.message}`));

  // Step 2.5: pre-pass to strip runtime-only entries that have no static
  // representation in the rootfs and would either fail verification or be
  // unsafe to declare. This keeps walk() structurally identical to the
  // verifier's walkTree() (both pure allowlist enforcers that record in-rootfs
  // symlinks and throw on escapers). The pre-pass is the one place the
  // producer diverges: it *removes* runtime-only entries rather than failing.
  //
  // Two cases are stripped:
  //   - Root-level `proc`/`dev`/`sys`: runtime virtual-fs mount points created
  //     fresh by assembleRootfs (proc/dev/tmp) and mounted at chroot time by
  //     helper.c. `dev` may also hold device nodes that walk() must reject.
  //   - Any symlink whose target escapes the rootfs (e.g. etc/mtab ->
  //     /proc/mounts): these are dangling at verification time (/proc is not
  //     mounted) and are a path-traversal vector if declared. Stripped by
  //     generic escape-check, never by name — a name-based allowlist of "safe
  //     absolute targets" would be a security regression.
  const rootResolved = path.resolve(treeDir);
  async function stripRuntimeOnly(rel) {
    const abs = rel === '' ? treeDir : path.join(treeDir, rel);
    const st = await fs.lstat(abs);
    if (rel === 'proc' || rel === 'dev' || rel === 'sys') {
      if (st.isDirectory() || st.isSymbolicLink()) {
        console.error(`build-runtime-rootfs: stripping runtime VFS placeholder ${rel}/`);
        await fs.rm(abs, { recursive: true, force: true });
      }
      return;
    }
    if (st.isSymbolicLink()) {
      const target = await fs.readlink(abs);
      const resolved = path.resolve(path.dirname(abs), target);
      if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
        console.error(`build-runtime-rootfs: stripping escaping symlink ${rel} -> ${target} (runtime-only; /proc is mounted at chroot time)`);
        await fs.rm(abs, { force: true });
      }
      return; // do not recurse into symlink targets
    }
    if (st.isDirectory()) {
      for (const c of await fs.readdir(abs)) {
        await stripRuntimeOnly(rel === '' ? c : `${rel}/${c}`);
      }
    }
    // files/devices elsewhere: leave to walk() to enforce
  }
  await stripRuntimeOnly('');

  // Step 3: walk the tree with the same allowlist rules as verifyRuntimeArtifact.
  const entries = [];
  async function walk(rel) {
    const abs = rel === '' ? treeDir : path.join(treeDir, rel);
    const st = await fs.lstat(abs);
    if (st.isSocket() || st.isFIFO() || st.isCharacterDevice() || st.isBlockDevice()) {
      die(`exported tree contains a special file (device/FIFO/socket): ${rel} — refusing`, 2);
    }
    if (st.isSymbolicLink()) {
      const target = await fs.readlink(abs);
      const resolved = path.resolve(path.dirname(abs), target);
      const rootRes = path.resolve(treeDir);
      // Defense-in-depth: the pre-pass should have stripped any escaper, but
      // walk() mirrors the verifier's walkTree() exactly — it throws on any
      // symlink that escapes the rootfs rather than ever recording it.
      if (!resolved.startsWith(rootRes + path.sep) && resolved !== rootRes) {
        die(`exported tree contains an escaping symlink: ${rel} -> ${target} — the pre-pass should have stripped this`, 2);
      }
      entries.push({
        path: rel,
        kind: 'symlink',
        mode: 0,
        size: 0,
        sha256: sha256Buffer(Buffer.from(target, 'utf8')),
        linkTarget: target,
      });
      return;
    }
    if (st.isDirectory()) {
      if (rel !== '') {
        if (rel.split('/').includes('..') || rel.startsWith('/')) die(`unsafe path in exported tree: ${rel}`, 2);
        entries.push({ path: rel, kind: 'directory', mode: st.mode & 0o7777, size: 0, sha256: sha256Buffer(Buffer.alloc(0)) });
      }
      for (const c of await fs.readdir(abs)) await walk(rel === '' ? c : `${rel}/${c}`);
    } else if (st.isFile()) {
      const mode = st.mode & 0o7777;
      const isExec = (mode & 0o111) !== 0;
      const isLib = /\.so(\.|$)/.test(rel);
      if ((isExec || isLib) && (mode & 0o022) !== 0) {
        die(`exported entry ${rel} is a group/world-writable executable or library (mode ${mode.toString(8)}) — refusing`, 2);
      }
      const buf = await fs.readFile(abs);
      entries.push({ path: rel, kind: 'file', mode, size: st.size, sha256: sha256Buffer(buf) });
    } else {
      die(`exported tree contains an unsupported file type: ${rel}`, 2);
    }
  }
  await walk('');
  entries.sort((a, b) => a.path.localeCompare(b.path));
  if (entries.length === 0) die('exported tree is empty — refusing to produce an empty manifest', 2);

  // Step 4: node binary + interpreter + DT_NEEDED closure, via the compiled parser.
  let rootfsMod;
  try {
    rootfsMod = await import(DIST_ROOTFS);
  } catch {
    die(`cannot import compiled verifier at ${DIST_ROOTFS}\n  Run \`pnpm --filter @agentoctopus/sandbox build\` first.`);
  }

  const nodeCandidates = ['usr/bin/node', 'bin/node', 'usr/local/bin/node'];
  const nodeRel = nodeCandidates.find((c) => entries.some((e) => e.path === c && e.kind === 'file' && (e.mode & 0o111) !== 0));
  if (!nodeRel) {
    die(`no executable node binary at /usr/bin/node, /bin/node, or /usr/local/bin/node in the exported tree of ${imageRef}`);
  }
  const nodePath = `/${nodeRel}`;

  // The verifier's ELF parser + closure logic is TypeScript and not exported
  // as standalone helpers, so for the build-side closure check we re-run the
  // same logic here against the on-disk tree (fail-closed, never guessed).
  const nodeBuf = await fs.readFile(path.join(treeDir, nodeRel));
  const elf = parseElf64ForBuild(nodeBuf);
  const declared = new Set(entries.map((e) => e.path));
  if (elf.interpreter) {
    const interpRel = elf.interpreter.startsWith('/') ? elf.interpreter.slice(1) : elf.interpreter;
    if (!declared.has(interpRel)) die(`node interpreter ${elf.interpreter} is absent from the exported tree`, 2);
  }
  const basenames = new Map();
  for (const e of entries) {
    if (e.kind === 'directory') continue;
    const base = e.path.split('/').pop();
    if (!basenames.has(base)) basenames.set(base, e.path);
  }
  for (const soname of elf.needed) {
    if (!basenames.has(soname)) die(`node DT_NEEDED library ${soname} is absent from the exported tree`, 2);
  }

  // Step 5: digests.
  const treeHashInput = entries
    .map((e) => `${e.path}:${e.kind}:${e.mode.toString(8)}:${e.size}:${e.sha256}`)
    .sort()
    .join('\n');
  const rootfsTreeSha256 = sha256Buffer(Buffer.from(treeHashInput));

  // Step 6: tar + zstd into a staging artifact, hash it, then atomic rename.
  const stageTar = path.join(stagingDir, 'rootfs.tar');
  const stageZst = path.join(stagingDir, 'rootfs.tar.zst');
  await fs.mkdir(RUNTIME_DIR, { recursive: true });
  await execFileAsync('tar', ['-cf', stageTar, '-C', treeDir, ...entries.map((e) => e.path)])
    .catch((err) => die(`tar packing failed: ${err.stderr ?? err.message}`));
  await execFileAsync('zstd', ['-q', '-19', '-f', '-o', stageZst, stageTar])
    .catch((err) => die(`zstd compression failed: ${err.stderr ?? err.message}`));
  const artifactSha256 = await sha256File(stageZst);

  const manifest = {
    schemaVersion: 1,
    artifactSha256,
    rootfsTreeSha256,
    nodePath,
    files: entries,
  };
  if (!SHA256_RE.test(artifactSha256) || !SHA256_RE.test(rootfsTreeSha256)) {
    die('internal error: computed digest is not 64 lowercase hex', 3);
  }

  await fs.copyFile(stageZst, `${ARTIFACT_PATH}.tmp-${process.pid}`);
  await fs.rename(`${ARTIFACT_PATH}.tmp-${process.pid}`, ARTIFACT_PATH);
  await writeAtomic(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');

  // Step 7: self-check with the REAL compiled verifier.
  try {
    await rootfsMod.verifyRuntimeArtifact({ artifactPath: ARTIFACT_PATH, manifestPath: MANIFEST_PATH });
  } catch (err) {
    await fs.rm(ARTIFACT_PATH, { force: true }).catch(() => {});
    await fs.rm(MANIFEST_PATH, { force: true }).catch(() => {});
    die(`self-check failed: verifyRuntimeArtifact rejected the just-produced pair: ${err.message}`, 3);
  }

  console.log(`build-runtime-rootfs: OK`);
  console.log(`  artifact:  ${ARTIFACT_PATH}`);
  console.log(`  manifest:  ${MANIFEST_PATH}`);
  console.log(`  image:     ${imageRef}`);
  console.log(`  entries:   ${entries.length}`);
  console.log(`  artifactSha256:   ${artifactSha256}`);
  console.log(`  rootfsTreeSha256: ${rootfsTreeSha256}`);
  console.log(`  self-check: verifyRuntimeArtifact passed`);
}

// ---------------------------------------------------------------------------
// Build-side ELF64 parse (kept in lockstep with src/os/rootfs.ts parseElf64,
// including PT_LOAD vaddr→offset translation for DT_STRTAB). The verifier
// does not export its parser, so the pre-check here duplicates it exactly;
// the authoritative check is the compiled verifyRuntimeArtifact() self-check.
// ---------------------------------------------------------------------------

function parseElf64ForBuild(buf) {
  const PT_LOAD = 1, PT_INTERP = 3, PT_DYNAMIC = 2, DT_NEEDED = 1, DT_NULL = 0, DT_STRTAB = 5;
  const fail = (m) => { die(`node binary ELF parse failed: ${m}`, 2); };
  if (buf.length < 64) fail('too small to be ELF64');
  if (buf.readUInt8(0) !== 0x7f || buf.toString('ascii', 1, 4) !== 'ELF') fail('bad magic');
  if (buf.readUInt8(4) !== 2) fail('not ELFCLASS64');
  if (buf.readUInt8(5) !== 1) fail('not little-endian');
  const e_phoff = Number(buf.readBigUInt64LE(32));
  const e_phentsize = buf.readUInt16LE(54);
  const e_phnum = buf.readUInt16LE(56);
  if (e_phoff === 0 || e_phnum === 0) fail('no program headers');
  let interpreter = null, dynOff = 0, dynFilesz = 0;
  const loads = [];
  for (let i = 0; i < e_phnum; i++) {
    const ph = e_phoff + i * e_phentsize;
    if (ph + e_phentsize > buf.length) fail('program header out of bounds');
    const p_type = buf.readUInt32LE(ph);
    const p_offset = Number(buf.readBigUInt64LE(ph + 8));
    const p_vaddr = Number(buf.readBigUInt64LE(ph + 16));
    const p_filesz = Number(buf.readBigUInt64LE(ph + 32));
    if (p_type === PT_LOAD) {
      if (p_offset + p_filesz > buf.length) fail('PT_LOAD out of bounds');
      loads.push({ vaddr: p_vaddr, offset: p_offset, filesz: p_filesz });
    } else if (p_type === PT_INTERP) {
      if (p_offset + p_filesz > buf.length) fail('PT_INTERP out of bounds');
      interpreter = buf.toString('utf8', p_offset, p_offset + p_filesz).replace(/\0+$/, '');
    } else if (p_type === PT_DYNAMIC) {
      dynOff = p_offset;
      dynFilesz = p_filesz;
    }
  }
  const needed = [];
  if (dynOff !== 0 && dynFilesz > 0) {
    if (dynOff + dynFilesz > buf.length) fail('PT_DYNAMIC out of bounds');
    let strtab = 0;
    const offs = [];
    for (let off = dynOff; off + 16 <= dynOff + dynFilesz; off += 16) {
      const tag = buf.readBigInt64LE(off);
      const val = Number(buf.readBigUInt64LE(off + 8));
      if (tag === BigInt(DT_NULL)) break;
      if (tag === BigInt(DT_STRTAB)) strtab = val;
      else if (tag === BigInt(DT_NEEDED)) offs.push(val);
    }
    let base = null;
    if (strtab !== 0) {
      if (strtab < buf.length && buf[strtab] === 0) base = strtab;
      else {
        for (const s of loads) {
          if (strtab >= s.vaddr && strtab < s.vaddr + s.filesz) {
            base = s.offset + (strtab - s.vaddr);
            break;
          }
        }
        if (base === null) fail(`DT_STRTAB vaddr 0x${strtab.toString(16)} not covered by any PT_LOAD`);
        if (base >= buf.length) fail('DT_STRTAB translated offset out of bounds');
      }
    }
    for (const so of offs) {
      const abs = (base ?? 0) + so;
      if (abs >= buf.length) fail('DT_NEEDED string offset out of bounds');
      let end = abs;
      while (end < buf.length && buf[end] !== 0) end++;
      if (end === buf.length) fail('DT_NEEDED string not NUL-terminated');
      const name = buf.toString('utf8', abs, end);
      if (name.length === 0) fail('DT_NEEDED resolved to empty soname');
      needed.push(name);
    }
  }
  return { interpreter, needed };
}

try {
  await main();
} finally {
  // Step 8: always remove the temporary container.
  if (containerCreated) {
    await execFileAsync('docker', ['rm', '-f', containerName]).catch((err) => {
      console.error(`build-runtime-rootfs: WARNING: docker rm ${containerName} failed: ${err.stderr ?? err.message}`);
    });
  }
  if (stagingDir) await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
}
