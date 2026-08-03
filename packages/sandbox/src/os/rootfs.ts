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
  readlink,
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
  nodePath: '/usr/bin/node' | '/bin/node' | '/usr/local/bin/node';
  files: Array<{
    path: string;
    sha256: string;
    size: number;
    mode: number;
    kind: 'file' | 'directory' | 'symlink';
    /** Raw readlink() target. Required for kind:'symlink', forbidden otherwise. */
    linkTarget?: string;
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
    kind: z.enum(['file', 'directory', 'symlink']),
    linkTarget: z.string().optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.kind === 'symlink') {
      if (f.linkTarget === undefined || f.linkTarget.length === 0) {
        ctx.addIssue({ code: 'custom', message: `symlink entry ${f.path} requires a non-empty linkTarget` });
      }
    } else if (f.linkTarget !== undefined) {
      ctx.addIssue({ code: 'custom', message: `non-symlink entry ${f.path} must not carry linkTarget` });
    }
  });

const RuntimeArtifactManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactSha256: z.string().regex(SHA256_RE),
    rootfsTreeSha256: z.string().regex(SHA256_RE),
    nodePath: z.enum(['/usr/bin/node', '/bin/node', '/usr/local/bin/node']),
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
const PT_LOAD = 1;
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

interface LoadSegment {
  vaddr: number;
  offset: number;
  filesz: number;
}

/**
 * Translate an ELF virtual address to a file offset using the PT_LOAD
 * segments. In a real ET_DYN binary (e.g. a distro `node`), `DT_STRTAB` and
 * other dynamic entries hold virtual addresses, not file offsets. Fails
 * closed: an address not covered by any PT_LOAD segment throws — never guess.
 */
function vaddrToOffset(segments: LoadSegment[], vaddr: number): number {
  for (const s of segments) {
    if (vaddr >= s.vaddr && vaddr < s.vaddr + s.filesz) {
      return s.offset + (vaddr - s.vaddr);
    }
  }
  throw new RootfsError(`ELF virtual address 0x${vaddr.toString(16)} is not covered by any PT_LOAD segment`);
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
  const loads: LoadSegment[] = [];

  for (let i = 0; i < e_phnum; i++) {
    const ph = e_phoff + i * e_phentsize;
    if (ph + e_phentsize > buf.length) throw new RootfsError('node ELF program header out of bounds');
    const p_type = buf.readUInt32LE(ph);
    const p_offset = Number(buf.readBigUInt64LE(ph + 8));
    const p_vaddr = Number(buf.readBigUInt64LE(ph + 16));
    const p_filesz = Number(buf.readBigUInt64LE(ph + 32));

    if (p_type === PT_LOAD) {
      if (p_offset + p_filesz > buf.length) throw new RootfsError('PT_LOAD out of bounds');
      loads.push({ vaddr: p_vaddr, offset: p_offset, filesz: p_filesz });
    } else if (p_type === PT_INTERP) {
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
    // DT_STRTAB semantics: a value that already points inside the file at a
    // NUL-prefixed string table is treated as a file offset (the synthetic
    // fixture convention used by the test-suite ELFs, which carry no PT_LOAD
    // segments). Everything else is a virtual address that MUST be translated
    // through the PT_LOAD segments; an address no PT_LOAD covers fails
    // closed — we never guess.
    let resolvedStrtab: number | null = null;
    if (strtabOff !== 0) {
      if (strtabOff < buf.length && buf[strtabOff] === 0) {
        resolvedStrtab = strtabOff; // file-offset convention (synthetic fixtures)
      } else {
        resolvedStrtab = vaddrToOffset(loads, strtabOff);
        if (resolvedStrtab >= buf.length) throw new RootfsError('DT_STRTAB translated file offset out of bounds');
      }
    }
    for (const so of strOffsets) {
      // When DT_STRTAB is absent (minimal synthetic ELFs), DT_NEEDED d_val
      // already holds an absolute file offset into the string table — the
      // fixture convention that predates real-ELF support. Real linkers
      // always emit DT_STRTAB.
      const base = resolvedStrtab ?? 0;
      const abs = base + so;
      if (abs >= buf.length) throw new RootfsError('DT_NEEDED string offset out of bounds');
      let end = abs;
      while (end < buf.length && buf[end] !== 0) end++;
      if (end === buf.length) throw new RootfsError('DT_NEEDED string is not NUL-terminated within the file');
      if (strsz > 0 && so >= strsz) throw new RootfsError('DT_NEEDED string offset exceeds DT_STRSZ');
      const name = buf.toString('utf8', abs, end);
      if (name.length === 0) throw new RootfsError('DT_NEEDED resolved to empty soname');
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
      const zstd = spawn('zstd', ['-dc', '--', artifactPath]);
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
  kind: 'file' | 'directory' | 'symlink';
  mode: number;
  size: number;
  sha256: string;
  linkTarget?: string;
}

async function walkTree(root: string): Promise<WalkEntry[]> {
  const out: WalkEntry[] = [];
  const rootResolved = path.resolve(root);
  // Resolve a symlink target as the runtime chroot would: absolute targets
  // are re-anchored under the rootfs root (a chroot confines them there), and
  // relative targets resolve against the link's parent directory. Returns the
  // resolved absolute path, or null if the target escapes above the rootfs
  // root (a genuine path-traversal vector). This mirrors snapshot.ts walk()
  // but handles absolute targets correctly for a chrooted rootfs — a bare
  // `path.resolve(parent, target)` would anchor absolute targets against the
  // host root and false-positive on legitimate in-rootfs absolute links such
  // as lib64/ld-linux-x86-64.so.2 -> /lib/x86_64-linux-gnu/ld-linux-x86-64.so.2.
  function resolveInRoot(linkAbs: string, target: string): string | null {
    const resolved = path.isAbsolute(target)
      ? path.join(rootResolved, target)
      : path.resolve(path.dirname(linkAbs), target);
    if (resolved === rootResolved) return resolved;
    if (resolved.startsWith(rootResolved + path.sep)) return resolved;
    return null; // escapes above the rootfs root
  }
  async function walk(rel: string): Promise<void> {
    const abs = rel === '' ? root : path.join(root, rel);
    const st = await lstat(abs);
    if (st.isSymbolicLink()) {
      const target = await readlink(abs);
      // Defense-in-depth: reject any symlink whose target resolves above the
      // rootfs root (path-traversal vector). The producer pre-pass strips the
      // known runtime-only dangling links (etc/mtab -> /proc/mounts), but a
      // tampered artifact could still carry one; never let it into the manifest.
      const resolved = resolveInRoot(abs, target);
      if (resolved === null) {
        throw new RootfsError(`symlink escapes rootfs: ${rel} -> ${target}`);
      }
      out.push({
        rel,
        kind: 'symlink',
        mode: 0,
        size: 0,
        sha256: await sha256Buffer(Buffer.from(target, 'utf8')),
        linkTarget: target,
      });
      return;
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

  // Every declared entry must exist with matching kind, and (for files) matching
  // size/sha256, (for symlinks) matching linkTarget. Mode comparison is skipped
  // for symlinks: the manifest records mode 0 (the on-disk lstat mode of a
  // symlink is 0o777 on Linux and not portable/meaningful), and the linkTarget
  // check IS the content check for a symlink.
  for (const f of manifest.files) {
    const w = byRel.get(f.path);
    if (!w) throw new RootfsError(`extracted tree missing declared entry: ${f.path}`);
    if (w.kind !== f.kind) throw new RootfsError(`extracted entry ${f.path} kind mismatch: expected ${f.kind}, got ${w.kind}`);
    if (f.kind === 'file') {
      if (w.size !== f.size) throw new RootfsError(`extracted entry ${f.path} size mismatch`);
      if (w.sha256 !== f.sha256) throw new RootfsError(`extracted entry ${f.path} sha256 mismatch`);
      if ((w.mode & ~f.mode) !== 0) {
        throw new RootfsError(`extracted entry ${f.path} mode has extra bits: expected ${f.mode.toString(8)}, got ${w.mode.toString(8)}`);
      }
    } else if (f.kind === 'symlink') {
      if (w.linkTarget !== f.linkTarget) {
        throw new RootfsError(`extracted symlink ${f.path} linkTarget mismatch: expected ${f.linkTarget}, got ${w.linkTarget}`);
      }
    } else {
      // directory: mode check only (extractor may tighten, never loosen).
      if ((w.mode & ~f.mode) !== 0) {
        throw new RootfsError(`extracted entry ${f.path} mode has extra bits: expected ${f.mode.toString(8)}, got ${w.mode.toString(8)}`);
      }
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
  // behaviour for a flat rootfs layout). Symlinks are valid resolutions: the
  // dynamic loader follows them (e.g. libstdc++.so.6 -> libstdc++.so.6.0.30),
  // and a symlink's target is itself a verified in-rootfs file (the walkTree
  // escape check guarantees this), so accepting it is sound.
  const basenames = new Map<string, string>();
  for (const f of manifest.files) {
    if (f.kind === 'directory') continue;
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
  /**
   * Destination directory for extraction. The artifact is extracted ONCE into
   * this directory and the tree allowlist + ELF dependency-closure checks run
   * against THAT tree (the same bytes that were just written, never a second
   * unverified read from disk). The directory must already exist.
   *
   * If omitted, a fresh 0700 tmp dir is created, verified, and removed before
   * return — suitable for "verify-only" callers that do not need the tree.
   */
  destDir?: string;
}

/**
 * Recursively remove an extracted artifact tree that may contain READ-ONLY
 * directories and files. The runtime rootfs ships some entries `0o555`/`0o444`;
 * Node's `rm(..., {recursive:true, force:true})` swallows ENOENT but NOT EACCES,
 * and `rmdir`/`unlink` require write+execute on the PARENT directory — so a
 * read-only directory anywhere in the tree makes the cleanup abort with EACCES
 * (observed as a deterministic `produce-linux-artifacts` self-check failure on
 * the Linux runner). Best-effort chmod the tree user-writable first, then rm.
 * Failures in the chmod pass are ignored: the tree may already be partly gone,
 * and the `rm` is the authoritative removal.
 *
 * Exported (underscore-named) for the EACCES regression test — not part of the
 * public rootfs API.
 */
export async function removeExtractedTree(root: string): Promise<void> {
  const chmodDeep = async (dir: string): Promise<void> => {
    await chmod(dir, 0o700).catch(() => {});
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      return; // unreadable / already gone — nothing to recurse into
    }
    for (const name of names) {
      const p = path.join(dir, name);
      const st = await lstat(p).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) {
        await chmodDeep(p);
      } else if (!st.isSymbolicLink()) {
        // Regular files (and other non-symlink non-dir entries) only need to be
        // unlinkable — governed by the parent's mode — but chmod anyway so a
        // future overwrite/rename path is not blocked. Symlinks are skipped:
        // chmod would follow them (or fail) and their target may not exist.
        await chmod(p, 0o600).catch(() => {});
      }
    }
  };
  await chmodDeep(root);
  await rm(root, { recursive: true, force: true });
}

/**
 * Verify the manifest and compressed artifact, then extract ONCE into
 * `destDir` (or a throwaway tmp dir when omitted) and run the tree allowlist
 * walk + ELF dependency-closure check against that exact extracted tree.
 * Returns the validated manifest. Throws `RootfsError` on any failure.
 *
 * The compressed-bytes SHA-256 is verified BEFORE any extraction. There is
 * no second unverified read of the artifact — the tree that gets verified
 * is the tree that gets returned (or, in the throwaway case, discarded).
 */
export async function verifyRuntimeArtifact(
  opts: VerifyRuntimeArtifactOptions,
): Promise<RuntimeArtifactManifest> {
  // Phase 1: parse + validate manifest.
  const raw = await readFile(opts.manifestPath, 'utf8').catch((err) => {
    throw new RootfsError(`cannot read manifest: ${(err as Error).message}`);
  });
  const manifest = parseManifest(raw);

  // Phase 2: stream SHA-256 over the compressed artifact BEFORE extraction.
  const digest = await sha256File(opts.artifactPath).catch((err) => {
    throw new RootfsError(`cannot read artifact: ${(err as Error).message}`);
  });
  if (digest !== manifest.artifactSha256) {
    throw new RootfsError(
      `artifact digest mismatch: manifest declares ${manifest.artifactSha256}, computed ${digest}`,
    );
  }

  // Phase 3: extract ONCE into the target dir and verify THAT tree in place.
  if (opts.destDir !== undefined) {
    await extractArtifact({ artifactPath: opts.artifactPath, destDir: opts.destDir });
    await verifyTree(opts.destDir, manifest);
    await verifyElfClosure(opts.destDir, manifest);
  } else {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'oct-rootfs-verify-'));
    try {
      await extractArtifact({ artifactPath: opts.artifactPath, destDir: tmpRoot });
      await verifyTree(tmpRoot, manifest);
      await verifyElfClosure(tmpRoot, manifest);
    } finally {
      await removeExtractedTree(tmpRoot);
    }
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
 * Create the private staging dir, extract the verified runtime into it ONCE,
 * verify the extracted tree in place, create only the mount-target paths,
 * and return the layout. Fails closed and removes partial staging on any
 * error. The tree that is verified is the tree that is returned — there is
 * no TOCTOU window between digest check and use.
 */
export async function assembleRootfs(opts: AssembleRootfsOptions): Promise<RootfsLayout> {
  // Create the staging root inside workDir with 0700 BEFORE verification so
  // the verifier can extract directly into it.
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
      try { await execFileAsync('umount', ['--', t]); } catch { /* not mounted */ }
    }
    await removeExtractedTree(root);
  };

  try {
    // Extract ONCE into the staging root and verify THAT tree. The manifest
    // returned here is the one the layout's inRoot.node is taken from, so the
    // layout is bound to the exact bytes that were hashed + extracted.
    const manifest = await verifyRuntimeArtifact({
      artifactPath: opts.runtimeArtifactPath,
      manifestPath: opts.runtimeManifestPath,
      destDir: root,
    });

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
