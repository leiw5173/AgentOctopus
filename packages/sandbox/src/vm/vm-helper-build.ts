// packages/sandbox/src/vm/vm-helper-build.ts
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export class VmTcbError extends Error {
  constructor(message: string) { super(message); this.name = 'VmTcbError'; }
}

const SHA256_RE = /^[0-9a-f]{64}$/;

const ArtifactEntrySchema = z.object({
  sha256: z.string().regex(SHA256_RE),
  size: z.number().int().positive(),
  mode: z.number().int().nonnegative(),
}).strict();

export const VmTcbManifestSchema = z.object({
  schemaVersion: z.literal(1),
  artifacts: z.object({
    helper: ArtifactEntrySchema,
    libkrun: ArtifactEntrySchema,
    libkrunfw: ArtifactEntrySchema,
    imageBuilder: ArtifactEntrySchema,
  }).strict(),
}).strict();
export type VmTcbManifest = z.infer<typeof VmTcbManifestSchema>;

export interface VmTcbArtifacts {
  helper: string; libkrun: string; libkrunfw: string; imageBuilder: string;
}

/**
 * The result of a TCB verification: the digest/size/mode-verified artifact
 * paths AND the exact manifest body those files were verified against.
 * Callers MUST thread `manifest` (never re-read the manifest path): between
 * verifyVmTcb() and a second read an attacker could swap the file so one
 * manifest verifies the binaries while another's digests match a signed gate
 * (verification-result substitution).
 */
export interface VmTcbVerified {
  paths: VmTcbArtifacts;
  manifest: VmTcbManifest;
}

async function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(p);
    s.on('data', (c: Buffer) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

async function verifyOne(name: string, path: string, entry: { sha256: string; size: number; mode: number }): Promise<void> {
  const lst = await lstat(path);
  if (!lst.isFile()) throw new VmTcbError(`${name}: not a regular file (symlink/missing)`);
  if (lst.isSymbolicLink()) throw new VmTcbError(`${name}: is a symlink`);
  const st = await stat(path);
  const d = await sha256File(path);
  if (d !== entry.sha256) throw new VmTcbError(`${name}: digest mismatch (expected ${entry.sha256}, got ${d})`);
  if (st.size !== entry.size) throw new VmTcbError(`${name}: size mismatch (expected ${entry.size}, got ${st.size})`);
  if ((st.mode & 0o777) !== entry.mode) throw new VmTcbError(`${name}: mode mismatch (expected ${entry.mode.toString(8)}, got ${(st.mode & 0o777).toString(8)})`);
  if (st.mode & 0o022) throw new VmTcbError(`${name}: group/world-writable (mode ${(st.mode & 0o777).toString(8)})`);
}

export async function verifyVmTcb(input: { artifactsDir: string; manifestPath: string }): Promise<VmTcbVerified> {
  const raw = await readFile(input.manifestPath, 'utf8');
  const manifest = VmTcbManifestSchema.parse(JSON.parse(raw));
  const paths: VmTcbArtifacts = {
    helper: join(input.artifactsDir, 'sandbox-vm-helper'),
    libkrun: join(input.artifactsDir, process.platform === 'darwin' ? 'libkrun.dylib' : 'libkrun.so'),
    libkrunfw: join(input.artifactsDir, process.platform === 'darwin' ? 'libkrunfw.dylib' : 'libkrunfw.so'),
    imageBuilder: join(input.artifactsDir, 'vm-image-builder'),
  };
  await verifyOne('helper', paths.helper, manifest.artifacts.helper);
  await verifyOne('libkrun', paths.libkrun, manifest.artifacts.libkrun);
  await verifyOne('libkrunfw', paths.libkrunfw, manifest.artifacts.libkrunfw);
  await verifyOne('imageBuilder', paths.imageBuilder, manifest.artifacts.imageBuilder);
  return { paths, manifest };
}
