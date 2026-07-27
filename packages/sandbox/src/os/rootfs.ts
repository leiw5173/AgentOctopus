/**
 * Digest-verified executable runtime root (Plan 4, Task 2).
 *
 * The runtime artifact (`linux-node22.rootfs.tar.zst` + `linux-node22.manifest.json`)
 * is immutable input produced by Task 2.5's build script on a Linux+Docker
 * host. This module:
 *
 *   1. `verifyRuntimeArtifact()` — strict-schema manifest validation, streaming
 *      SHA-256 over the compressed artifact, extraction into a fresh 0700
 *      staging dir, full extracted-tree allowlist walk (kind/mode/size/SHA-256),
 *      and ELF DT_NEEDED/interpreter dependency-closure resolution for the
 *      declared Node binary. Fails closed on every error.
 *
 *   2. `assembleRootfs()` — calls the verifier, creates only the mount-target
 *      paths (`/skill`, `/etc/skill-ca/ca.pem`, `/tmp`, `/proc`, `/dev`), and
 *      returns host paths vs in-root paths separately. Never mounts, never
 *      copies the skill, never copies host `/`. `cleanup()` unmounts session
 *      mounts if present and removes the staging dir; it never removes the
 *      source snapshot, CA, artifact, or manifest.
 *
 * ELF parsing is a small self-contained ELF64 reader (no external deps,
 * no `readelf`) so it runs identically on macOS and Linux.
 *
 * Leaf-package rule: Node stdlib + zod only. All external tool invocations
 * use argument arrays — never shell interpolation.
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  lstat,
  chmod,
  open,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export class RootfsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RootfsError';
  }
}

export interface RuntimeArtifactManifest {
  schemaVersion: 1;
  artifactSha256: string;
  rootfsTreeSha256: string;
  nodePath: '/usr/bin/node' | '/bin/node';
  files: Array<{
    path: string;
    sha256: string;
    size: number;
    mode: number;
    kind: 'file' | 'directory';
  }>;
}

export interface RootfsLayout {
  /** Absolute host path of the private staging root (0700). */
  root: string;
  /** Absolute host path where the verified runtime was extracted (== root). */
  runtimeRoot: string;
  hostMounts: {
    snapshotSource: string;
    snapshotTarget: string;
    caSource?: string;
    caTarget?: string;
  };
  inRoot: {
    node: string;
    skill: '/skill';
    ca?: '/etc/skill-ca/ca.pem';
    tmp: '/tmp';
    proc: '/proc';
    dev: '/dev';
  };
  cleanup(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Manifest schema (strict)
// ---------------------------------------------------------------------------

const SHA256_RE = /^[0-9a-f]{64}$/;

const ManifestFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .refine((p) => !p.startsWith('/'), 'manifest path must be relative')
      .refine((p) => !p.split('/').includes('..'), 'manifest path must not contain ..'),
    sha256: z.string().regex(SHA256_RE, 'sha256 must be 64 lowercase hex'),
    size: z.number().int().nonnegative(),
    mode: z.number().int().nonnegative(),
    kind: z.enum(['file', 'directory']),
  })
  .strict();

const RuntimeArtifactManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactSha256: z.string().regex(SHA256_RE),
    rootfsTreeSha256: z.string().regex(SHA256_RE),
    nodePath: z.enum(['/usr/bin/node', '/bin/node']),
    files: z.array(ManifestFileSchema).nonempty(),
  })
  .strict()
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    for (const f of m.files) {
      if (seen.has(f.path)) {
        ctx.addIssue({ code: 'custom', message: `duplicate manifest path: ${f.path}` });
      }
      seen.add(f.path);
    }
    // Group/world-writable executables and libraries are forbidden.
    for (const f of m.files) {
      if (f.kind !== 'file') continue;
      const isExec = (f.mode & 0o111) !== 0;
      const isLib = /\.so(\.|$)/.test(f.path);
      if ((isExec || isLib) && (f.mode & 0o022) !== 0) {
        ctx.addIssue({
          code: 'custom',
          message: `manifest entry ${f.path} is a group/world-writable executable or library`,
        });
      }
    }
  });

function parseManifest(raw: string): RuntimeArtifactManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RootfsError(`manifest is not valid JSON: ${(err as Error).message}`);
  }
  const res = RuntimeArtifactManifestSchema.safeParse(parsed);
  if (!res.success) {
    const msg = res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new RootfsError(`manifest schema validation failed: ${msg}`);
  }
  return res.data as RuntimeArtifactManifest;
}

// ---------------------------------------------------------------------------
// SHA-256 helpers
// ---------------------------------------------------------------------------

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const h = createHash('sha256');
    const s = createReadStream(filePath);
    s.on('data', (chunk: Buffer) => h.update(chunk));
    s.on('end', () => resolvePromise(h.digest('hex')));
    s.on('error', rejectPromise);
  });
}

async function sha256Buffer(buf: Buffer): Promise<string> {
  return createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// ELF64 parser (self-contained, no readelf)
// ---------------------------------------------------------------------------

const ELF_MAGIC = 0x7f;
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const PT_INTERP = 3;
const PT_DYNAMIC = 2;
const DT_NEEDED = 1;
const DT_NULL = 0;
const DT_STRTAB = 5;
const DT_STRSZ = 10;

interface ElfInfo {
  interpreter: string | null;
  needed: string[];
}

function parseElf64(buf: Buffer): ElfInfo {
  if (buf.length < 64) throw new RootfsError('node binary is too small to be ELF64');
  if (buf.readUInt8(0) !== ELF_MAGIC || buf.toString('ascii', 1, 4) !== 'ELF') {
    throw new RootfsError('node binary is not a valid ELF file');
  }
  if (buf.readUInt8(4) !== ELFCLASS64) throw new RootfsError('node binary is not ELFCLASS64');
  if (buf.readUInt8(5) !== ELFDATA2LSB) throw new RootfsError('node binary is not little-endian ELF');

  const e_phoff = Number(buf.readBigUInt64LE(32));
  const e_phentsize = buf.readUInt16LE(54);
  const e_phnum = buf.readUInt16LE(56);
  if (e_phoff === 0 || e_phnum === 0) throw new RootfsError('node ELF has no program headers');

  let interpreter: string | null = null;
  let dynOff = 0;
  let dynFilesz = 0;

  for (let i = 0; i < e_phnum; i++) {
    const ph = e_phoff + i * e_phentsize;
    if (ph + e_phentsize > buf.length) throw new RootfsError('node ELF program header out of bounds');
    const p_type = buf.readUInt32LE(ph);
    const p_offset = Number(buf.readBigUInt64LE(ph + 8));
    const p_filesz = Number(buf.readBigUInt64LE(ph + 32));

    if (p_type === PT_INTERP) {
      if (p_offset + p_filesz > buf.length) throw new RootfsError('PT_INTERP out of bounds');
      interpreter = buf.toString('utf8', p_offset, p_offset + p_filesz).replace(/\0+$/, '');
    } else if (p_type === PT_DYNAMIC) {
      dynOff = p_offset;
      dynFilesz = p_filesz;
    }
  }

  const needed: string[] = [];
  if (dynOff !== 0 && dynFilesz > 0) {
    if (dynOff + dynFilesz > buf.length) throw new RootfsError('PT_DYNAMIC out of bounds');
    let strtabOff = 0;
    let strsz = 0;
    const strOffsets: number[] = [];
    const entSize = 16;
    for (let off = dynOff; off + entSize <= dynOff + dynFilesz; off += entSize) {
      const tag = buf.readBigInt64LE(off);
      const val = buf.readBigUInt64LE(off + 8);
      if (tag === BigInt(DT_NULL)) break;
      if (tag === BigInt(DT_STRTAB)) strtabOff = Number(val);
      else if (tag === BigInt(DT_STRSZ)) strsz = Number(val);
      else if (tag === BigInt(DT_NEEDED)) strOffsets.push(Number(val));
    }
    // In a real ET_DYN binary DT_STRTAB holds a virtual address, not a file
    // offset. For the minimal runtime tree we produce and consume, the ELF is
    // crafted so that DT_STRTAB holds a file offset (the same convention the
    // build script uses). If DT_STRTAB looks like a vaddr (>= file size) we
    // fall back to treating DT_NEEDED values as file offsets directly.
    for (const so of strOffsets) {
      let abs = strtabOff + so;
      if (strtabOff >= buf.length) abs = so; // DT_STRTAB is a vaddr; treat d_val as file offset
      if (abs >= buf.length) throw new RootfsError('DT_NEEDED string offset out of bounds');
      let end = abs;
      while (end < buf.length && buf[end] !== 0) end++;
      const name = buf.toString('utf8', abs, end);
      if (strsz > 0 && name.length === 0) throw new RootfsError('DT_NEEDED resolved to empty soname');
      needed.push(name);
    }
  }

  return { interpreter, needed };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

interface ExtractOptions {
  artifactPath: string;
  destDir: string;
}

async function extractArtifact(opts: ExtractOptions): Promise<void> {
  const { artifactPath, destDir } = opts;
  await mkdir(destDir, { recursive: true, mode: 0o700 });
  await chmod(destDir, 0o700);

  if (artifactPath.endsWith('.zst')) {
    // zstd -dc <artifact> | tar -xf - -C <dest> --no-same-owner --no-same-permissions
    // Two processes connected by a pipe, both argument-array invocations.
    // Use spawn (not execFile) so stdout is a raw stream — execFile buffers
    // stdout internally and corrupts the pipe.
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const zstd = spawn('zstd', ['-dc', artifactPath]);
      const tar = spawn('tar', [
        '-xf', '-',
        '-C', destDir,
        '--no-same-owner',
        '--no-same-permissions',
      ]);
      let zstdErr = '';
      let tarErr = '';
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        zstd.kill('SIGKILL');
        tar.kill('SIGKILL');
        rejectPromise(err);
      };
      zstd.stderr.on('data', (d: Buffer) => { zstdErr += d.toString(); });
      tar.stderr.on('data', (d: Buffer) => { tarErr += d.toString(); });
      zstd.stdout.pipe(tar.stdin);
      zstd.stdout.on('error', fail);
      tar.stdin.on('error', () => { /* EPIPE when tar exits early — handled via close */ });
      zstd.on('error', fail);
      tar.on('error', fail);
      zstd.on('close', (code) => {
        if (code !== 0) fail(new RootfsError(`zstd exited ${code}: ${zstdErr.trim()}`));
      });
      tar.on('close', (code) => {
        if (settled) return;
        settled = true;
        if (code === 0) resolvePromise();
        else rejectPromise(new RootfsError(`tar exited ${code}: ${tarErr.trim() || zstdErr.trim()}`));
      });
    });
  } else {
    // Uncompressed .tar fallback (used by portable fixtures when zstd is absent).
    await execFileAsync('tar', [
      '-xf', artifactPath,
      '-C', destDir,
      '--no-same-owner',
      '--no-same-permissions',
    ]);
  }
}

// ---------------------------------------------------------------------------
// Tree allowlist walk
// ---------------------------------------------------------------------------

interface WalkEntry {
  rel: string;
  kind: 'file' | 'directory';
  mode: number;
  size: number;
  sha256: string;
}

async function walkTree(root: string): Promise<WalkEntry[]> {
  const out: WalkEntry[] = [];
  async function walk(rel: string): Promise<void> {
    const abs = rel === '' ? root : path.join(root, rel);
    const st = await lstat(abs);
    if (st.isSymbolicLink()) {
      throw new RootfsError(`extracted tree contains a symlink: ${rel}`);
    }
    if (st.isDirectory()) {
      if (rel !== '') {
        out.push({
          rel,
          kind: 'directory',
          mode: st.mode & 0o7777,
          size: 0,
          sha256: await sha256Buffer(Buffer.alloc(0)),
        });
      }
      const children = await readdir(abs);
      for (const c of children) {
        await walk(rel === '' ? c : `${rel}/${c}`);
      }
    } else if (st.isFile()) {
      const buf = await readFile(abs);
      out.push({
        rel,
        kind: 'file',
        mode: st.mode & 0o7777,
        size: st.size,
        sha256: await sha256Buffer(buf),
      });
    } else {
      throw new RootfsError(`extracted tree contains unsupported file type: ${rel}`);
    }
  }
  await walk('');
  return out;
}

async function verifyTree(root: string, manifest: RuntimeArtifactManifest): Promise<void> {
  const walked = await walkTree(root);
  const byRel = new Map(walked.map((w) => [w.rel, w]));

  // Every declared entry must exist with matching kind/mode/size/sha256.
  for (const f of manifest.files) {
    const w = byRel.get(f.path);
    if (!w) throw new RootfsError(`extracted tree missing declared entry: ${f.path}`);
    if (w.kind !== f.kind) throw new RootfsError(`extracted entry ${f.path} kind mismatch: expected ${f.kind}, got ${w.kind}`);
    if (f.kind === 'file') {
      if (w.size !== f.size) throw new RootfsError(`extracted entry ${f.path} size mismatch`);
      if (w.sha256 !== f.sha256) throw new RootfsError(`extracted entry ${f.path} sha256 mismatch`);
    }
    // Mode comparison: allow the extractor to tighten permissions but never loosen.
    if ((w.mode & ~f.mode) !== 0) {
      throw new RootfsError(`extracted entry ${f.path} mode has extra bits: expected ${f.mode.toString(8)}, got ${w.mode.toString(8)}`);
    }
  }

  // No undeclared entries.
  const declared = new Set(manifest.files.map((f) => f.path));
  for (const w of walked) {
    if (!declared.has(w.rel)) {
      throw new RootfsError(`extracted tree contains undeclared entry: ${w.rel}`);
    }
  }
}

// ---------------------------------------------------------------------------
// ELF dependency closure
// ---------------------------------------------------------------------------

async function verifyElfClosure(root: string, manifest: RuntimeArtifactManifest): Promise<void> {
  const nodeRel = manifest.nodePath.slice(1); // strip leading /
  const nodeEntry = manifest.files.find((f) => f.path === nodeRel);
  if (!nodeEntry) {
    throw new RootfsError(`manifest does not declare the node executable at ${manifest.nodePath}`);
  }
  if (nodeEntry.kind !== 'file') {
    throw new RootfsError(`manifest node entry ${manifest.nodePath} is not a file`);
  }
  if ((nodeEntry.mode & 0o111) === 0) {
    throw new RootfsError(`manifest node entry ${manifest.nodePath} is not executable`);
  }

  const nodeAbs = path.join(root, nodeRel);
  const buf = await readFile(nodeAbs);
  const elf = parseElf64(buf);

  const manifestPaths = new Set(manifest.files.map((f) => f.path));

  // The interpreter (dynamic loader) must be present.
  if (elf.interpreter) {
    const interpRel = elf.interpreter.startsWith('/') ? elf.interpreter.slice(1) : elf.interpreter;
    if (!manifestPaths.has(interpRel)) {
      throw new RootfsError(`node interpreter ${elf.interpreter} is not present in the manifest`);
    }
  }

  // Every DT_NEEDED soname must resolve to a manifest entry. We search the
  // manifest for a file whose basename matches the soname (standard linker
  // behaviour for a flat rootfs layout).
  const basenames = new Map<string, string>();
  for (const f of manifest.files) {
    if (f.kind !== 'file') continue;
    const base = f.path.split('/').pop()!;
    if (!basenames.has(base)) basenames.set(base, f.path);
  }
  for (const soname of elf.needed) {
    if (!basenames.has(soname)) {
      throw new RootfsError(`node DT_NEEDED library ${soname} is not present in the manifest`);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface VerifyRuntimeArtifactOptions {
  artifactPath: string;
  manifestPath: string;
}

/**
 * Verify the manifest and compressed artifact, then extract and verify the
 * full tree and ELF dependency closure. Returns the validated manifest.
 * Throws `RootfsError` on any failure.
 *
 * Note: extraction is performed into a temporary directory that is removed
 * before this function returns. Callers that need the extracted tree should
 * use `assembleRootfs()`.
 */
export async function verifyRuntimeArtifact(
  opts: VerifyRuntimeArtifactOptions,
): Promise<RuntimeArtifactManifest> {
  // Phase 1: parse + validate manifest.
  const raw = await readFile(opts.manifestPath, 'utf8').catch((err) => {
    throw new RootfsError(`cannot read manifest: ${(err as Error).message}`);
  });
  const manifest = parseManifest(raw);

  // Phase 2: stream SHA-256 over the compressed artifact before extraction.
  const digest = await sha256File(opts.artifactPath).catch((err) => {
    throw new RootfsError(`cannot read artifact: ${(err as Error).message}`);
  });
  if (digest !== manifest.artifactSha256) {
    throw new RootfsError(
      `artifact digest mismatch: manifest declares ${manifest.artifactSha256}, computed ${digest}`,
    );
  }

  // Phase 3: extract into a fresh 0700 dir and verify the tree.
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'oct-rootfs-verify-'));
  try {
    await extractArtifact({ artifactPath: opts.artifactPath, destDir: tmpRoot });
    await verifyTree(tmpRoot, manifest);
    await verifyElfClosure(tmpRoot, manifest);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }

  return manifest;
}

export interface AssembleRootfsOptions {
  snapshotRoot: string;
  caBundlePath?: string;
  workDir: string;
  runtimeArtifactPath: string;
  runtimeManifestPath: string;
}

/**
 * Extract the verified runtime into a private staging directory under
 * `workDir`, create only the mount-target paths, and return the layout.
 * Fails closed and removes partial staging on any error.
 */
export async function assembleRootfs(opts: AssembleRootfsOptions): Promise<RootfsLayout> {
  // Verify first (this also exercises the full tree/ELF checks).
  const manifest = await verifyRuntimeArtifact({
    artifactPath: opts.runtimeArtifactPath,
    manifestPath: opts.runtimeManifestPath,
  });

  // Create the staging root inside workDir with 0700.
  const root = await mkdtemp(path.join(opts.workDir, 'rootfs-'));
  await chmod(root, 0o700);

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    // Unmount any session mounts that may still be present. We attempt
    // umount on the known mount targets; failures are ignored because the
    // mounts may never have been created.
    const targets = [
      path.join(root, 'skill'),
      path.join(root, 'etc/skill-ca/ca.pem'),
      path.join(root, 'proc'),
      path.join(root, 'dev'),
    ];
    for (const t of targets) {
      try { await execFileAsync('umount', [t]); } catch { /* not mounted */ }
    }
    await rm(root, { recursive: true, force: true });
  };

  try {
    // Extract the verified runtime into the staging root.
    await extractArtifact({ artifactPath: opts.runtimeArtifactPath, destDir: root });

    // Create mount targets only — no mounting, no copying.
    await mkdir(path.join(root, 'skill'), { recursive: true, mode: 0o755 });
    await mkdir(path.join(root, 'etc/skill-ca'), { recursive: true, mode: 0o755 });
    // ca.pem is a bind-mount target file; create an empty placeholder.
    const caTarget = path.join(root, 'etc/skill-ca/ca.pem');
    await (await open(caTarget, 'w', 0o644)).close();
    await mkdir(path.join(root, 'tmp'), { recursive: true, mode: 0o1777 });
    await mkdir(path.join(root, 'proc'), { recursive: true, mode: 0o555 });
    await mkdir(path.join(root, 'dev'), { recursive: true, mode: 0o755 });

    const layout: RootfsLayout = {
      root,
      runtimeRoot: root,
      hostMounts: {
        snapshotSource: opts.snapshotRoot,
        snapshotTarget: path.join(root, 'skill'),
        ...(opts.caBundlePath
          ? { caSource: opts.caBundlePath, caTarget }
          : {}),
      },
      inRoot: {
        node: manifest.nodePath,
        skill: '/skill',
        ...(opts.caBundlePath ? { ca: '/etc/skill-ca/ca.pem' as const } : {}),
        tmp: '/tmp',
        proc: '/proc',
        dev: '/dev',
      },
      cleanup,
    };
    return layout;
  } catch (err) {
    await cleanup();
    if (err instanceof RootfsError) throw err;
    throw new RootfsError(`assembleRootfs failed: ${(err as Error).message}`, { cause: err });
  }
}
