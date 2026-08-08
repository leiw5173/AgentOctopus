/**
 * Windows runtime manifest verifier.
 *
 * Verifies the integrity of a trusted Windows Node runtime closure: the
 * node.exe executable, the sandbox bootstrap script, and the vendored undici
 * directory. Each entry is checked for exact sha256 digest and byte size. The
 * manifest is the anchor for the AppContainer / job-object file grants a
 * deny-default Windows sandbox profile may safely enumerate.
 *
 * This module is leaf-package production code: Node stdlib only.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export interface WindowsRuntimeManifestEntry {
  path: string;
  sha256: string;
  size: number;
}

export interface WindowsRuntimeManifest {
  schemaVersion: 1;
  nodePath: string; // trusted node.exe, absolute
  bootstrapPath: string; // sandbox bootstrap .cjs, absolute
  undiciDir: string; // vendored undici directory, absolute
  nodeSha256: string;
  bootstrapSha256: string;
  entries: WindowsRuntimeManifestEntry[];
}

export class WindowsRuntimeManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WindowsRuntimeManifestError';
  }
}

const SHA256_RE = /^[0-9a-f]{64}$/;

function assertDigest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new WindowsRuntimeManifestError(`${field} must be a 64-char lowercase hex sha256, got: ${JSON.stringify(value)}`);
  }
  return value;
}

async function hashFile(p: string): Promise<string> {
  const buf = await readFile(p);
  return createHash('sha256').update(buf).digest('hex');
}

function assertAbsolutePath(value: unknown, field: string): string {
  // Windows absolute paths may be drive-letter (C:\... or C:/...) or UNC
  // (\\server\share\...). Node's isAbsolute on the host platform recognises
  // POSIX paths only, so accept both forms explicitly here.
  if (typeof value !== 'string' || value.length === 0) {
    throw new WindowsRuntimeManifestError(`${field} must be a non-empty absolute path, got: ${JSON.stringify(value)}`);
  }
  const winAbs = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
  if (!winAbs && !isAbsolute(value)) {
    throw new WindowsRuntimeManifestError(`${field} must be an absolute path, got: ${JSON.stringify(value)}`);
  }
  return value;
}

async function verifyEntry(entry: unknown, field: string): Promise<WindowsRuntimeManifestEntry> {
  if (typeof entry !== 'object' || entry === null) {
    throw new WindowsRuntimeManifestError(`${field} entry must be an object`);
  }
  const e = entry as Record<string, unknown>;
  const p = assertAbsolutePath(e.path, `${field}.path`);
  const sha256 = assertDigest(e.sha256, `${field}.sha256`);
  if (typeof e.size !== 'number' || !Number.isInteger(e.size) || e.size < 0) {
    throw new WindowsRuntimeManifestError(`${field}.size must be a non-negative integer, got: ${JSON.stringify(e.size)}`);
  }

  let st;
  try {
    st = await stat(p);
  } catch {
    throw new WindowsRuntimeManifestError(`${field}.path does not exist: ${p}`);
  }
  if (st.size !== e.size) {
    throw new WindowsRuntimeManifestError(`${field}.size mismatch for ${p}: manifest ${e.size}, actual ${st.size}`);
  }
  const actualDigest = await hashFile(p);
  if (actualDigest !== sha256) {
    throw new WindowsRuntimeManifestError(`${field}.sha256 mismatch for ${p}: digest does not match manifest`);
  }
  return { path: p, sha256, size: e.size };
}

/**
 * Load and verify a Windows runtime manifest from disk. Throws
 * WindowsRuntimeManifestError on any schema, digest, or size mismatch.
 * Returns a deeply frozen manifest on success.
 */
export async function verifyWindowsRuntimeManifest(manifestPath: string): Promise<WindowsRuntimeManifest> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    throw new WindowsRuntimeManifestError(`cannot read manifest: ${manifestPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WindowsRuntimeManifestError(`manifest is not valid JSON: ${manifestPath}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new WindowsRuntimeManifestError('manifest must be a JSON object');
  }
  const m = parsed as Record<string, unknown>;

  if (m.schemaVersion !== 1) {
    throw new WindowsRuntimeManifestError(`unsupported schemaVersion: ${JSON.stringify(m.schemaVersion)} (expected 1)`);
  }

  const nodePath = assertAbsolutePath(m.nodePath, 'nodePath');
  const bootstrapPath = assertAbsolutePath(m.bootstrapPath, 'bootstrapPath');
  const undiciDir = assertAbsolutePath(m.undiciDir, 'undiciDir');
  const nodeSha256 = assertDigest(m.nodeSha256, 'nodeSha256');
  const bootstrapSha256 = assertDigest(m.bootstrapSha256, 'bootstrapSha256');

  if (!Array.isArray(m.entries)) {
    throw new WindowsRuntimeManifestError('entries must be an array');
  }
  const entries: WindowsRuntimeManifestEntry[] = [];
  for (let i = 0; i < m.entries.length; i++) {
    entries.push(await verifyEntry(m.entries[i], `entries[${i}]`));
  }

  // Cross-check the top-level digests against their corresponding entries:
  // the node.exe and bootstrap digests must be present in entries and must
  // agree with the per-entry values.
  const nodeEntry = entries.find((e) => e.path === nodePath);
  if (!nodeEntry) {
    throw new WindowsRuntimeManifestError(`entries must include nodePath: ${nodePath}`);
  }
  if (nodeEntry.sha256 !== nodeSha256) {
    throw new WindowsRuntimeManifestError(`nodeSha256 does not match the entries[] digest for ${nodePath}`);
  }
  const bootEntry = entries.find((e) => e.path === bootstrapPath);
  if (!bootEntry) {
    throw new WindowsRuntimeManifestError(`entries must include bootstrapPath: ${bootstrapPath}`);
  }
  if (bootEntry.sha256 !== bootstrapSha256) {
    throw new WindowsRuntimeManifestError(`bootstrapSha256 does not match the entries[] digest for ${bootstrapPath}`);
  }

  const result: WindowsRuntimeManifest = {
    schemaVersion: 1,
    nodePath,
    bootstrapPath,
    undiciDir,
    nodeSha256,
    bootstrapSha256,
    entries,
  };
  Object.freeze(entries);
  for (const e of entries) Object.freeze(e);
  return Object.freeze(result);
}
