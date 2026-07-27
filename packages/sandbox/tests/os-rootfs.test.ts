/**
 * Tests for packages/sandbox/src/os/rootfs.ts (Plan 4, Task 2).
 *
 * Layout
 * ------
 * 1. Portable unit tests — run on any host (macOS included). They exercise
 *    manifest schema validation, tamper detection, extracted-tree allowlist
 *    walk, ELF DT_NEEDED/interpreter resolution, and the mount-target shape
 *    of `assembleRootfs()`. All fixtures are built at test time with tar+zstd
 *    (both available on macOS via Homebrew, always present on Linux).
 *
 * 2. Real-artifact tests — consume `runtime/linux-node22.rootfs.tar.zst` +
 *    `runtime/linux-node22.manifest.json` produced by Task 2.5's build script
 *    on a Linux+Docker host. They are skipped when the artifact is absent or
 *    the platform is not Linux. Setting `OCTOPUS_REQUIRE_OS_SANDBOX=1`
 *    converts a would-be skip into a hard failure, matching the convention in
 *    `tests/os-probe.test.ts`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assembleRootfs,
  verifyRuntimeArtifact,
  RootfsError,
  type RootfsLayout,
  type RuntimeArtifactManifest,
} from '../src/os/rootfs.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

interface Tmp { dir: string; cleanup: () => Promise<void> }

async function mkdtemp(prefix: string): Promise<Tmp> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

const tmps: Tmp[] = [];
async function tmp(prefix: string): Promise<string> {
  const t = await mkdtemp(prefix);
  tmps.push(t);
  return t.dir;
}
afterEach(async () => {
  while (tmps.length) await tmps.pop()!.cleanup();
});

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

interface FileSpec { rel: string; content: Buffer; mode: number }

/**
 * Write files into `dir`, build a tar.zst of the tree, return
 * { tarPath, manifest } — the manifest faithfully records every entry.
 */
async function buildArtifact(
  dir: string,
  files: FileSpec[],
  opts: { nodePath?: '/usr/bin/node' | '/bin/node'; compress?: boolean } = {},
): Promise<{ artifactPath: string; manifest: RuntimeArtifactManifest }> {
  const entries: RuntimeArtifactManifest['files'] = [];

  // Directories first (sorted), then files.
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.rel.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  for (const d of [...dirs].sort()) {
    const full = path.join(dir, d);
    await fs.mkdir(full, { recursive: true, mode: 0o755 });
    entries.push({ path: d, sha256: sha256(Buffer.alloc(0)), size: 0, mode: 0o755, kind: 'directory' });
  }
  for (const f of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    const full = path.join(dir, f.rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, f.content, { mode: f.mode });
    await fs.chmod(full, f.mode);
    entries.push({ path: f.rel, sha256: sha256(f.content), size: f.content.length, mode: f.mode, kind: 'file' });
  }

  const artifactPath = path.join(dir, '..', `artifact-${crypto.randomBytes(4).toString('hex')}.tar${opts.compress === false ? '' : '.zst'}`);
  // Simpler: always produce an intermediate .tar then optionally zstd it.
  const tarPath = artifactPath.replace(/\.tar\.zst$|\.tar$/, '') + '.tar';
  await execFileAsync('tar', ['-cf', tarPath, '-C', dir, ...entries.map((e) => e.path)]);
  let finalPath = tarPath;
  if (opts.compress !== false) {
    finalPath = tarPath + '.zst';
    await execFileAsync('zstd', ['-q', '-f', '-o', finalPath, tarPath]);
  }
  const artifactBuf = await fs.readFile(finalPath);

  const treeHashInput = entries
    .map((e) => `${e.path}:${e.kind}:${e.mode.toString(8)}:${e.size}:${e.sha256}`)
    .sort()
    .join('\n');
  const manifest: RuntimeArtifactManifest = {
    schemaVersion: 1,
    artifactSha256: sha256(artifactBuf),
    rootfsTreeSha256: sha256(Buffer.from(treeHashInput)),
    nodePath: opts.nodePath ?? '/usr/bin/node',
    files: entries,
  };
  return { artifactPath: finalPath, manifest };
}

async function writeManifest(dir: string, manifest: unknown): Promise<string> {
  const p = path.join(dir, 'manifest.json');
  await fs.writeFile(p, JSON.stringify(manifest));
  return p;
}

// ---------------------------------------------------------------------------
// ELF64 fixture builder (little-endian, x86_64, ET_DYN, PT_INTERP, DT_NEEDED)
// ---------------------------------------------------------------------------

const PT_INTERP = 3;
const PT_DYNAMIC = 2;
const DT_NEEDED = 1;
const DT_NULL = 0;

function buildElf64(opts: { interp?: string; needed?: string[] }): Buffer {
  const interp = opts.interp ?? '/lib64/ld-linux-x86-64.so.2';
  const needed = opts.needed ?? [];
  const interpBytes = Buffer.from(interp + '\0', 'utf8');
  const strtabPieces: Buffer[] = [];
  const strOffsets: number[] = [];
  let strOff = 1; // leading NUL
  for (const n of needed) {
    strOffsets.push(strOff);
    const b = Buffer.from(n + '\0', 'utf8');
    strtabPieces.push(b);
    strOff += b.length;
  }
  const strtab = Buffer.concat([Buffer.from([0]), ...strtabPieces]);

  const ehdrSize = 64;
  const phdrSize = 56;
  const nPhdr = 2;
  const interpOff = ehdrSize + phdrSize * nPhdr;
  const dynOff = interpOff + interpBytes.length;
  const dynEnt = 16;
  const nDyn = needed.length + 1;
  const strtabOff = dynOff + dynEnt * nDyn;
  const total = strtabOff + strtab.length;

  const buf = Buffer.alloc(total);

  // ELF header
  buf.writeUInt8(0x7f, 0); buf.write('ELF', 1, 'ascii');
  buf.writeUInt8(2, 4);  // ELFCLASS64
  buf.writeUInt8(1, 5);  // ELFDATA2LSB
  buf.writeUInt8(1, 6);  // EV_CURRENT
  buf.writeUInt8(0, 7);  // System V ABI
  buf.writeUInt16LE(3, 16);      // e_type = ET_DYN
  buf.writeUInt16LE(0x3e, 18);   // e_machine = x86_64
  buf.writeUInt32LE(1, 20);      // e_version
  buf.writeBigUInt64LE(0n, 24);  // e_entry
  buf.writeBigUInt64LE(BigInt(ehdrSize), 32); // e_phoff
  buf.writeBigUInt64LE(0n, 40);  // e_shoff
  buf.writeUInt32LE(0, 48);      // e_flags
  buf.writeUInt16LE(ehdrSize, 52);
  buf.writeUInt16LE(phdrSize, 54);
  buf.writeUInt16LE(nPhdr, 56);

  // PT_INTERP phdr
  buf.writeUInt32LE(PT_INTERP, ehdrSize);
  buf.writeUInt32LE(4, ehdrSize + 4); // PF_R
  buf.writeBigUInt64LE(BigInt(interpOff), ehdrSize + 8);
  buf.writeBigUInt64LE(0n, ehdrSize + 16);
  buf.writeBigUInt64LE(0n, ehdrSize + 24);
  buf.writeBigUInt64LE(BigInt(interpBytes.length), ehdrSize + 32);
  buf.writeBigUInt64LE(BigInt(interpBytes.length), ehdrSize + 40);
  buf.writeBigUInt64LE(1n, ehdrSize + 48);
  interpBytes.copy(buf, interpOff);

  // PT_DYNAMIC phdr
  const p2 = ehdrSize + phdrSize;
  buf.writeUInt32LE(PT_DYNAMIC, p2);
  buf.writeUInt32LE(6, p2 + 4); // PF_R|PF_W
  buf.writeBigUInt64LE(BigInt(dynOff), p2 + 8);
  buf.writeBigUInt64LE(0n, p2 + 16);
  buf.writeBigUInt64LE(0n, p2 + 24);
  buf.writeBigUInt64LE(BigInt(dynEnt * nDyn), p2 + 32);
  buf.writeBigUInt64LE(BigInt(dynEnt * nDyn), p2 + 40);
  buf.writeBigUInt64LE(8n, p2 + 48);

  // Dynamic section
  for (let i = 0; i < needed.length; i++) {
    buf.writeBigInt64LE(BigInt(DT_NEEDED), dynOff + i * dynEnt);
    buf.writeBigUInt64LE(BigInt(strtabOff + strOffsets[i]), dynOff + i * dynEnt + 8);
  }
  buf.writeBigInt64LE(BigInt(DT_NULL), dynOff + needed.length * dynEnt);
  buf.writeBigUInt64LE(0n, dynOff + needed.length * dynEnt + 8);

  strtab.copy(buf, strtabOff);
  return buf;
}

/** A minimal but complete fake runtime tree with a valid node ELF. */
async function makeValidRuntime(): Promise<{
  treeDir: string;
  artifactPath: string;
  manifestPath: string;
  manifest: RuntimeArtifactManifest;
}> {
  const treeDir = await tmp('oct-rootfs-tree-');
  const nodeElf = buildElf64({ interp: '/lib64/ld-linux-x86-64.so.2', needed: ['libnode.so.127'] });
  const loader = Buffer.from('fake-loader');
  const libnode = Buffer.from('fake-libnode');
  const { artifactPath, manifest } = await buildArtifact(treeDir, [
    { rel: 'usr/bin/node', content: nodeElf, mode: 0o755 },
    { rel: 'lib64/ld-linux-x86-64.so.2', content: loader, mode: 0o755 },
    { rel: 'usr/lib/libnode.so.127', content: libnode, mode: 0o755 },
  ], { nodePath: '/usr/bin/node' });
  const manifestPath = await writeManifest(path.dirname(artifactPath), manifest);
  return { treeDir, artifactPath, manifestPath, manifest };
}

// ---------------------------------------------------------------------------
// 1. Portable unit tests
// ---------------------------------------------------------------------------

describe('verifyRuntimeArtifact — manifest schema', () => {
  it('accepts a valid manifest + matching artifact', async () => {
    const { artifactPath, manifestPath, manifest } = await makeValidRuntime();
    const got = await verifyRuntimeArtifact({ artifactPath, manifestPath });
    expect(got.nodePath).toBe(manifest.nodePath);
    expect(got.files.length).toBe(manifest.files.length);
  });

  it('rejects a manifest with duplicate paths', async () => {
    const { artifactPath, manifest } = await makeValidRuntime();
    const bad = { ...manifest, files: [...manifest.files, manifest.files[0]] };
    const manifestPath = await writeManifest(await tmp('oct-m-'), bad);
    await expect(verifyRuntimeArtifact({ artifactPath, manifestPath }))
      .rejects.toThrow(RootfsError);
  });

  it('rejects a manifest with absolute paths', async () => {
    const { artifactPath, manifest } = await makeValidRuntime();
    const bad = {
      ...manifest,
      files: [...manifest.files, { path: '/etc/passwd', sha256: sha256(Buffer.alloc(0)), size: 0, mode: 0o644, kind: 'file' }],
    };
    const manifestPath = await writeManifest(await tmp('oct-m-'), bad);
    await expect(verifyRuntimeArtifact({ artifactPath, manifestPath }))
      .rejects.toThrow(RootfsError);
  });

  it('rejects a manifest with .. traversal', async () => {
    const { artifactPath, manifest } = await makeValidRuntime();
    const bad = {
      ...manifest,
      files: [...manifest.files, { path: 'usr/../../etc/shadow', sha256: sha256(Buffer.alloc(0)), size: 0, mode: 0o644, kind: 'file' }],
    };
    const manifestPath = await writeManifest(await tmp('oct-m-'), bad);
    await expect(verifyRuntimeArtifact({ artifactPath, manifestPath }))
      .rejects.toThrow(RootfsError);
  });

  it('rejects a manifest with an unsupported kind', async () => {
    const { artifactPath, manifest } = await makeValidRuntime();
    const bad = {
      ...manifest,
      files: [...manifest.files, { path: 'dev/null', sha256: sha256(Buffer.alloc(0)), size: 0, mode: 0o644, kind: 'device' }],
    };
    const manifestPath = await writeManifest(await tmp('oct-m-'), bad);
    await expect(verifyRuntimeArtifact({ artifactPath, manifestPath }))
      .rejects.toThrow(RootfsError);
  });

  it('rejects a manifest with unknown top-level fields (strict)', async () => {
    const { artifactPath, manifest } = await makeValidRuntime();
    const bad = { ...manifest, evil: true };
    const manifestPath = await writeManifest(await tmp('oct-m-'), bad);
    await expect(verifyRuntimeArtifact({ artifactPath, manifestPath }))
      .rejects.toThrow(RootfsError);
  });

  it('rejects a nodePath outside the allowed enum', async () => {
    const { artifactPath, manifest } = await makeValidRuntime();
    const bad = { ...manifest, nodePath: '/usr/local/bin/node' };
    const manifestPath = await writeManifest(await tmp('oct-m-'), bad);
    await expect(verifyRuntimeArtifact({ artifactPath, manifestPath }))
      .rejects.toThrow(RootfsError);
  });
});

describe('verifyRuntimeArtifact — artifact digest', () => {
  it('rejects a tampered archive before extraction', async () => {
    const { artifactPath, manifestPath } = await makeValidRuntime();
    const tmp2 = await tmp('oct-tampered-');
    const copy = path.join(tmp2, 'artifact.tar.zst');
    await fs.copyFile(artifactPath, copy);
    await fs.appendFile(copy, Buffer.from([0]));
    await expect(verifyRuntimeArtifact({ artifactPath: copy, manifestPath }))
      .rejects.toThrow(/digest/i);
  });

  it('rejects when manifest artifactSha256 does not match the artifact', async () => {
    const { artifactPath, manifest } = await makeValidRuntime();
    const bad = { ...manifest, artifactSha256: sha256(Buffer.from('not-the-artifact')) };
    const manifestPath = await writeManifest(await tmp('oct-m-'), bad);
    await expect(verifyRuntimeArtifact({ artifactPath, manifestPath }))
      .rejects.toThrow(/digest/i);
  });
});

describe('verifyRuntimeArtifact — extracted-tree allowlist', () => {
  it('rejects when a declared file content is tampered inside the archive', async () => {
    // Build a tree, then build the archive from a DIFFERENT tree whose
    // libnode content differs while the manifest still records the original
    // digest. The archive digest will match the manifest, but the extracted
    // file digest will not.
    const treeDir = await tmp('oct-tree-a-');
    const nodeElf = buildElf64({ interp: '/lib64/ld-linux-x86-64.so.2', needed: ['libnode.so.127'] });
    const filesA = [
      { rel: 'usr/bin/node', content: nodeElf, mode: 0o755 },
      { rel: 'lib64/ld-linux-x86-64.so.2', content: Buffer.from('loader'), mode: 0o755 },
      { rel: 'usr/lib/libnode.so.127', content: Buffer.from('libnode-A'), mode: 0o755 },
    ];
    const { manifest } = await buildArtifact(treeDir, filesA, { nodePath: '/usr/bin/node' });

    // Now build the actual archive from a tree where libnode differs.
    const treeDirB = await tmp('oct-tree-b-');
    const filesB = [
      { rel: 'usr/bin/node', content: nodeElf, mode: 0o755 },
      { rel: 'lib64/ld-linux-x86-64.so.2', content: Buffer.from('loader'), mode: 0o755 },
      { rel: 'usr/lib/libnode.so.127', content: Buffer.from('libnode-B-tampered'), mode: 0o755 },
    ];
    // Manually construct tree B
    for (const f of filesB) {
      const full = path.join(treeDirB, f.rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, f.content, { mode: f.mode });
      await fs.chmod(full, f.mode);
    }
    const tarPath = path.join(await tmp('oct-art-'), 'b.tar');
    const allPaths = ['usr', 'usr/bin', 'usr/bin/node', 'usr/lib', 'usr/lib/libnode.so.127', 'lib64', 'lib64/ld-linux-x86-64.so.2'];
    await execFileAsync('tar', ['-cf', tarPath, '-C', treeDirB, ...allPaths]);
    const zstPath = tarPath + '.zst';
    await execFileAsync('zstd', ['-q', '-f', '-o', zstPath, tarPath]);
    const artifactBuf = await fs.readFile(zstPath);
    const fixedManifest = { ...manifest, artifactSha256: sha256(artifactBuf) };
    const manifestPath = await writeManifest(path.dirname(zstPath), fixedManifest);

    await expect(verifyRuntimeArtifact({ artifactPath: zstPath, manifestPath }))
      .rejects.toThrow(RootfsError);
  });

  it('rejects when the archive contains an entry not listed in the manifest', async () => {
    const treeDir = await tmp('oct-tree-c-');
    const nodeElf = buildElf64({ interp: '/lib64/ld-linux-x86-64.so.2', needed: ['libnode.so.127'] });
    const files = [
      { rel: 'usr/bin/node', content: nodeElf, mode: 0o755 },
      { rel: 'lib64/ld-linux-x86-64.so.2', content: Buffer.from('loader'), mode: 0o755 },
      { rel: 'usr/lib/libnode.so.127', content: Buffer.from('libnode'), mode: 0o755 },
    ];
    const { artifactPath, manifest } = await buildArtifact(treeDir, files, { nodePath: '/usr/bin/node' });

    // Remove one file entry from the manifest so the archive now contains
    // an undeclared entry. Recompute artifactSha256 so digest check passes.
    const artifactBuf = await fs.readFile(artifactPath);
    const badManifest = {
      ...manifest,
      artifactSha256: sha256(artifactBuf),
      files: manifest.files.filter((f) => f.path !== 'usr/lib/libnode.so.127'),
    };
    const manifestPath = await writeManifest(await tmp('oct-m-'), badManifest);
    await expect(verifyRuntimeArtifact({ artifactPath, manifestPath }))
      .rejects.toThrow(RootfsError);
  });

  it('rejects a group/world-writable executable in the manifest', async () => {
    const treeDir = await tmp('oct-tree-d-');
    const nodeElf = buildElf64({ interp: '/lib64/ld-linux-x86-64.so.2', needed: ['libnode.so.127'] });
    const files = [
      { rel: 'usr/bin/node', content: nodeElf, mode: 0o777 }, // world-writable exec
      { rel: 'lib64/ld-linux-x86-64.so.2', content: Buffer.from('loader'), mode: 0o755 },
      { rel: 'usr/lib/libnode.so.127', content: Buffer.from('libnode'), mode: 0o755 },
    ];
    const { artifactPath, manifest } = await buildArtifact(treeDir, files, { nodePath: '/usr/bin/node' });
    const artifactBuf = await fs.readFile(artifactPath);
    const fixed = { ...manifest, artifactSha256: sha256(artifactBuf) };
    const manifestPath = await writeManifest(await tmp('oct-m-'), fixed);
    await expect(verifyRuntimeArtifact({ artifactPath, manifestPath }))
      .rejects.toThrow(/writable/i);
  });
});

describe('verifyRuntimeArtifact — ELF dependency closure', () => {
  it('rejects when node declares a DT_NEEDED library absent from the manifest', async () => {
    const treeDir = await tmp('oct-tree-e-');
    // node needs libmissing.so.1 but the tree does not provide it.
    const nodeElf = buildElf64({ interp: '/lib64/ld-linux-x86-64.so.2', needed: ['libmissing.so.1'] });
    const files = [
      { rel: 'usr/bin/node', content: nodeElf, mode: 0o755 },
      { rel: 'lib64/ld-linux-x86-64.so.2', content: Buffer.from('loader'), mode: 0o755 },
    ];
    const { artifactPath, manifest } = await buildArtifact(treeDir, files, { nodePath: '/usr/bin/node' });
    const artifactBuf = await fs.readFile(artifactPath);
    const fixed = { ...manifest, artifactSha256: sha256(artifactBuf) };
    const manifestPath = await writeManifest(await tmp('oct-m-'), fixed);
    await expect(verifyRuntimeArtifact({ artifactPath, manifestPath }))
      .rejects.toThrow(/libmissing/i);
  });

  it('rejects when node declares an interpreter absent from the manifest', async () => {
    const treeDir = await tmp('oct-tree-f-');
    const nodeElf = buildElf64({ interp: '/lib64/ld-missing.so.2', needed: [] });
    const files = [
      { rel: 'usr/bin/node', content: nodeElf, mode: 0o755 },
    ];
    const { artifactPath, manifest } = await buildArtifact(treeDir, files, { nodePath: '/usr/bin/node' });
    const artifactBuf = await fs.readFile(artifactPath);
    const fixed = { ...manifest, artifactSha256: sha256(artifactBuf) };
    const manifestPath = await writeManifest(await tmp('oct-m-'), fixed);
    await expect(verifyRuntimeArtifact({ artifactPath, manifestPath }))
      .rejects.toThrow(/interpreter|ld-missing/i);
  });

  it('rejects when the node binary is not valid ELF', async () => {
    const treeDir = await tmp('oct-tree-g-');
    const files = [
      { rel: 'usr/bin/node', content: Buffer.from('#!/bin/sh\necho hi\n'), mode: 0o755 },
      { rel: 'lib64/ld-linux-x86-64.so.2', content: Buffer.from('loader'), mode: 0o755 },
    ];
    const { artifactPath, manifest } = await buildArtifact(treeDir, files, { nodePath: '/usr/bin/node' });
    const artifactBuf = await fs.readFile(artifactPath);
    const fixed = { ...manifest, artifactSha256: sha256(artifactBuf) };
    const manifestPath = await writeManifest(await tmp('oct-m-'), fixed);
    await expect(verifyRuntimeArtifact({ artifactPath, manifestPath }))
      .rejects.toThrow(/ELF/i);
  });
});

// ---------------------------------------------------------------------------
// assembleRootfs — portable mount-target shape tests (real runtime fixture)
// ---------------------------------------------------------------------------

describe('assembleRootfs', () => {
  let layout: RootfsLayout | undefined;
  afterEach(async () => { await layout?.cleanup(); layout = undefined; });

  it('creates distinct host mount targets and in-root paths', async () => {
    const { artifactPath, manifestPath } = await makeValidRuntime();
    const snap = await tmp('oct-snap-');
    await fs.writeFile(path.join(snap, 'invoke.js'), 'console.log(1)');
    const caDir = await tmp('oct-ca-');
    const ca = path.join(caDir, 'ca.pem');
    await fs.writeFile(ca, 'test-ca');
    const work = await tmp('oct-rootfs-work-');

    layout = await assembleRootfs({
      snapshotRoot: snap,
      caBundlePath: ca,
      workDir: work,
      runtimeArtifactPath: artifactPath,
      runtimeManifestPath: manifestPath,
    });

    expect(layout.hostMounts.snapshotSource).toBe(snap);
    expect(layout.hostMounts.snapshotTarget).toBe(path.join(layout.root, 'skill'));
    expect(layout.hostMounts.caSource).toBe(ca);
    expect(layout.hostMounts.caTarget).toBe(path.join(layout.root, 'etc/skill-ca/ca.pem'));
    expect(layout.inRoot.skill).toBe('/skill');
    expect(layout.inRoot.ca).toBe('/etc/skill-ca/ca.pem');
    expect(layout.inRoot.node).toMatch(/^\/(usr\/bin|bin)\/node$/);
    expect(layout.inRoot.tmp).toBe('/tmp');
    expect(layout.inRoot.proc).toBe('/proc');
    expect(layout.inRoot.dev).toBe('/dev');

    // Mount targets exist on the host side.
    await expect(fs.stat(layout.hostMounts.snapshotTarget)).resolves.toBeTruthy();
    await expect(fs.stat(layout.hostMounts.caTarget!)).resolves.toBeTruthy();
    await expect(fs.stat(path.join(layout.root, 'tmp'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(layout.root, 'proc'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(layout.root, 'dev'))).resolves.toBeTruthy();

    // Staging dir is 0700.
    const rootStat = await fs.stat(layout.root);
    expect(rootStat.mode & 0o777).toBe(0o700);

    // The verified node binary landed at the declared in-root path.
    await expect(
      fs.access(path.join(layout.root, layout.inRoot.node.slice(1)), fs.constants.X_OK),
    ).resolves.toBeUndefined();

    // inRoot values never contain the host root path.
    for (const v of Object.values(layout.inRoot)) {
      if (typeof v === 'string') expect(v.includes(layout.root)).toBe(false);
    }
  });

  it('cleanup() removes the staging dir but never the source snapshot/CA/artifact', async () => {
    const { artifactPath, manifestPath } = await makeValidRuntime();
    const snap = await tmp('oct-snap-');
    await fs.writeFile(path.join(snap, 'invoke.js'), 'x');
    const ca = path.join(await tmp('oct-ca-'), 'ca.pem');
    await fs.writeFile(ca, 'ca');
    const work = await tmp('oct-rootfs-work-');

    layout = await assembleRootfs({
      snapshotRoot: snap, caBundlePath: ca, workDir: work,
      runtimeArtifactPath: artifactPath, runtimeManifestPath: manifestPath,
    });
    const root = layout.root;
    await layout.cleanup();
    layout = undefined;

    await expect(fs.stat(root)).rejects.toThrow();
    await expect(fs.stat(snap)).resolves.toBeTruthy();
    await expect(fs.stat(ca)).resolves.toBeTruthy();
    await expect(fs.stat(artifactPath)).resolves.toBeTruthy();
    await expect(fs.stat(manifestPath)).resolves.toBeTruthy();
  });

  it('fails closed and removes partial staging on verification error', async () => {
    const { artifactPath, manifest } = await makeValidRuntime();
    const bad = { ...manifest, artifactSha256: sha256(Buffer.from('nope')) };
    const manifestPath = await writeManifest(await tmp('oct-m-'), bad);
    const snap = await tmp('oct-snap-');
    const work = await tmp('oct-rootfs-work-');

    await expect(assembleRootfs({
      snapshotRoot: snap, workDir: work,
      runtimeArtifactPath: artifactPath, runtimeManifestPath: manifestPath,
    })).rejects.toThrow(RootfsError);

    // workDir must not contain leftover staging dirs.
    const leftovers = await fs.readdir(work);
    expect(leftovers).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Regression: the staging tree returned by assembleRootfs MUST itself have
  // been verified against the manifest allowlist — not a second unverified
  // read from disk. We assert this two ways:
  //
  //   (a) Single-extraction: tampering with the on-disk artifact AFTER the
  //       digest check would only ever produce one extraction of tampered
  //       bytes, which the in-place verifyTree() then rejects. We simulate
  //       the race by crafting a fixture whose archive digest matches the
  //       manifest but whose extracted tree content does not.
  //
  //   (b) Tree-equivalence: every file the staging root contains (other than
  //       the mount targets assembleRootfs creates post-verification) appears
  //       in the manifest with a matching SHA-256. If a second unverified
  //       extraction had happened, the tree would not match the manifest.
  // -------------------------------------------------------------------------

  it('verifies the staging tree itself against the manifest (no unverified second extraction)', async () => {
    const { artifactPath, manifestPath, manifest } = await makeValidRuntime();
    const snap = await tmp('oct-snap-');
    const work = await tmp('oct-rootfs-work-');

    layout = await assembleRootfs({
      snapshotRoot: snap, workDir: work,
      runtimeArtifactPath: artifactPath, runtimeManifestPath: manifestPath,
    });

    // Every manifest-declared file must exist in the staging root with a
    // matching SHA-256 — proving the staging tree is the one that was
    // verified, not a fresh unverified read from disk.
    const declaredFiles = manifest.files.filter((f) => f.kind === 'file');
    expect(declaredFiles.length).toBeGreaterThan(0);
    for (const f of declaredFiles) {
      const buf = await fs.readFile(path.join(layout.root, f.path));
      const actual = sha256(buf);
      expect(actual).toBe(f.sha256);
    }

    // Conversely, every non-mount-target file in the staging root must be
    // declared in the manifest. Mount targets created post-verification are
    // exactly: skill/, etc/skill-ca/, etc/skill-ca/ca.pem, tmp/, proc/, dev/.
    const mountTargets = new Set([
      'skill', 'etc', 'etc/skill-ca', 'etc/skill-ca/ca.pem', 'tmp', 'proc', 'dev',
    ]);
    const declaredPaths = new Set(manifest.files.map((f) => f.path));
    async function walk(rel: string): Promise<string[]> {
      const abs = rel === '' ? layout!.root : path.join(layout!.root, rel);
      const st = await fs.lstat(abs);
      if (st.isDirectory()) {
        const children = await fs.readdir(abs);
        const sub: string[] = [];
        for (const c of children) sub.push(...await walk(rel === '' ? c : `${rel}/${c}`));
        return rel === '' ? sub : [rel, ...sub];
      }
      return [rel];
    }
    const allPaths = await walk('');
    for (const p of allPaths) {
      if (mountTargets.has(p)) continue;
      expect(declaredPaths.has(p)).toBe(true);
    }
  });

  it('rejects when the extracted tree does not match the manifest, even if the archive digest matches', async () => {
    // The archive digest matches the manifest, but the extracted tree has a
    // tampered libnode. If assembleRootfs extracted once and skipped the
    // staging-tree verification, this would return a layout instead of
    // rejecting. (Same fixture as the verifyRuntimeArtifact tree-tamper test,
    // driven through assembleRootfs to prove the staging tree is verified.)
    const treeDir = await tmp('oct-tree-t-');
    const nodeElf = buildElf64({ interp: '/lib64/ld-linux-x86-64.so.2', needed: ['libnode.so.127'] });
    const filesA = [
      { rel: 'usr/bin/node', content: nodeElf, mode: 0o755 },
      { rel: 'lib64/ld-linux-x86-64.so.2', content: Buffer.from('loader'), mode: 0o755 },
      { rel: 'usr/lib/libnode.so.127', content: Buffer.from('libnode-A'), mode: 0o755 },
    ];
    const { manifest } = await buildArtifact(treeDir, filesA, { nodePath: '/usr/bin/node' });

    const treeDirB = await tmp('oct-tree-tb-');
    for (const f of [
      { rel: 'usr/bin/node', content: nodeElf, mode: 0o755 },
      { rel: 'lib64/ld-linux-x86-64.so.2', content: Buffer.from('loader'), mode: 0o755 },
      { rel: 'usr/lib/libnode.so.127', content: Buffer.from('libnode-B-tampered'), mode: 0o755 },
    ]) {
      const full = path.join(treeDirB, f.rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, f.content, { mode: f.mode });
      await fs.chmod(full, f.mode);
    }
    const tarPath = path.join(await tmp('oct-art-'), 'b.tar');
    await execFileAsync('tar', ['-cf', tarPath, '-C', treeDirB,
      'usr', 'usr/bin', 'usr/bin/node', 'usr/lib', 'usr/lib/libnode.so.127',
      'lib64', 'lib64/ld-linux-x86-64.so.2']);
    const zstPath = tarPath + '.zst';
    await execFileAsync('zstd', ['-q', '-f', '-o', zstPath, tarPath]);
    const artifactBuf = await fs.readFile(zstPath);
    const fixed = { ...manifest, artifactSha256: sha256(artifactBuf) };
    const manifestPath = await writeManifest(await tmp('oct-m-'), fixed);

    const snap = await tmp('oct-snap-');
    const work = await tmp('oct-rootfs-work-');
    await expect(assembleRootfs({
      snapshotRoot: snap, workDir: work,
      runtimeArtifactPath: zstPath, runtimeManifestPath: manifestPath,
    })).rejects.toThrow(RootfsError);
    expect(await fs.readdir(work)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Real-artifact tests (Linux lane only)
// ---------------------------------------------------------------------------

const isLinux = process.platform === 'linux';
const REQUIRE_OS = process.env.OCTOPUS_REQUIRE_OS_SANDBOX === '1';
const realArtifact = path.resolve(__dirname, '../runtime/linux-node22.rootfs.tar.zst');
const realManifest = path.resolve(__dirname, '../runtime/linux-node22.manifest.json');

async function realArtifactPresent(): Promise<boolean> {
  try {
    await fs.access(realArtifact);
    await fs.access(realManifest);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!isLinux)('runtime rootfs — real artifact (Linux lane)', () => {
  it('verifies the archive and complete tree manifest before use', async () => {
    if (!(await realArtifactPresent())) {
      if (REQUIRE_OS) throw new Error(`OCTOPUS_REQUIRE_OS_SANDBOX=1 but ${realArtifact} not found`);
      return; // soft skip
    }
    const manifest = await verifyRuntimeArtifact({ artifactPath: realArtifact, manifestPath: realManifest });
    expect(['/usr/bin/node', '/bin/node']).toContain(manifest.nodePath);
    expect(manifest.files.some((f) => f.path === manifest.nodePath.slice(1) && (f.mode & 0o111) !== 0)).toBe(true);
    expect(manifest.files.some((f) => /ld-linux|ld-musl/.test(f.path))).toBe(true);
  });

  it('creates distinct host mount targets and in-root paths from the real artifact', async () => {
    if (!(await realArtifactPresent())) {
      if (REQUIRE_OS) throw new Error(`OCTOPUS_REQUIRE_OS_SANDBOX=1 but ${realArtifact} not found`);
      return;
    }
    const snap = await fs.mkdtemp(path.join(os.tmpdir(), 'oct-snap-'));
    await fs.writeFile(path.join(snap, 'invoke.js'), 'console.log(1)');
    const ca = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'oct-ca-')), 'ca.pem');
    await fs.writeFile(ca, 'test-ca');
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'oct-rootfs-'));
    let realLayout: RootfsLayout | undefined;
    try {
      realLayout = await assembleRootfs({
        snapshotRoot: snap, caBundlePath: ca, workDir: work,
        runtimeArtifactPath: realArtifact, runtimeManifestPath: realManifest,
      });
      expect(realLayout.hostMounts.snapshotSource).toBe(snap);
      expect(realLayout.hostMounts.snapshotTarget).toBe(path.join(realLayout.root, 'skill'));
      expect(realLayout.inRoot.skill).toBe('/skill');
      expect(realLayout.inRoot.ca).toBe('/etc/skill-ca/ca.pem');
      expect(realLayout.inRoot.node).toMatch(/^\/(usr\/bin|bin)\/node$/);
      await expect(
        fs.access(path.join(realLayout.root, realLayout.inRoot.node.slice(1)), fs.constants.X_OK),
      ).resolves.toBeUndefined();
    } finally {
      await realLayout?.cleanup();
    }
  });

  it('rejects a tampered copy of the real archive before extraction', async () => {
    if (!(await realArtifactPresent())) {
      if (REQUIRE_OS) throw new Error(`OCTOPUS_REQUIRE_OS_SANDBOX=1 but ${realArtifact} not found`);
      return;
    }
    const tmpD = await fs.mkdtemp(path.join(os.tmpdir(), 'oct-runtime-'));
    const copy = path.join(tmpD, 'runtime.tar.zst');
    await fs.copyFile(realArtifact, copy);
    await fs.appendFile(copy, Buffer.from([0]));
    await expect(verifyRuntimeArtifact({ artifactPath: copy, manifestPath: realManifest }))
      .rejects.toThrow(/digest/i);
  });

  it('chroot smoke: node --version runs inside the verified rootfs', async () => {
    if (!(await realArtifactPresent())) {
      if (REQUIRE_OS) throw new Error(`OCTOPUS_REQUIRE_OS_SANDBOX=1 but ${realArtifact} not found`);
      return;
    }
    const snap = await fs.mkdtemp(path.join(os.tmpdir(), 'oct-snap-'));
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'oct-rootfs-'));
    let realLayout: RootfsLayout | undefined;
    try {
      realLayout = await assembleRootfs({
        snapshotRoot: snap, workDir: work,
        runtimeArtifactPath: realArtifact, runtimeManifestPath: realManifest,
      });
      const nodeInRoot = realLayout.inRoot.node;
      // chroot <root> <node> --version — proves loader + DT_NEEDED closure.
      const { stdout } = await execFileAsync('chroot', [realLayout.root, nodeInRoot, '--version']);
      expect(stdout).toMatch(/^v\d+\./);
    } finally {
      await realLayout?.cleanup();
    }
  });
});
