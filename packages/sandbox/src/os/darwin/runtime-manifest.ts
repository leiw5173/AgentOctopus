/**
 * Darwin runtime manifest verifier.
 *
 * Verifies the integrity of a trusted macOS Node runtime closure: the executable,
 * its Mach-O dylib closure, and adjacent data files (e.g. ICU). Each entry is
 * checked for exact sha256 digest, byte size, and permission mode (no group- or
 * world-writable bits). The manifest is the anchor for the SBPL file grants a
 * deny-default sandbox profile may safely enumerate.
 *
 * This module is leaf-package production code: Node stdlib only.
 */
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { readFile } from 'node:fs/promises';

export interface DarwinRuntimeManifestEntry {
  path: string;
  sha256: string;
  size: number;
  mode: number;
}

export type JitPolicy = 'jitless' | 'dynamic-code-generation';

export interface DarwinRuntimeManifest {
  schemaVersion: 1;
  executablePath: string; // trusted Node, absolute
  sha256: string;
  size: number;
  mode: number;
  dylibs: DarwinRuntimeManifestEntry[];
  dataFiles: DarwinRuntimeManifestEntry[];
  machServices: string[]; // exact names, audited
  sysctls: string[]; // exact keys, audited
  jitPolicy: JitPolicy;
}

export class DarwinRuntimeManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DarwinRuntimeManifestError';
  }
}

const SHA256_RE = /^[0-9a-f]{64}$/;
// Exact Mach service names and sysctl keys only: no wildcard/glob characters.
const EXACT_NAME_RE = /^[A-Za-z0-9._-]+$/;
// No setuid/setgid/sticky and no group/other write bits.
const FORBIDDEN_MODE_BITS = 0o6022;

function assertExactName(value: unknown, field: string): string {
  if (typeof value !== 'string' || !EXACT_NAME_RE.test(value)) {
    throw new DarwinRuntimeManifestError(
      `${field} entry must be an exact name matching ${EXACT_NAME_RE}, got: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function assertDigest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new DarwinRuntimeManifestError(`${field} must be a 64-char lowercase hex sha256, got: ${JSON.stringify(value)}`);
  }
  return value;
}

async function hashFile(p: string): Promise<string> {
  const buf = await readFile(p);
  return createHash('sha256').update(buf).digest('hex');
}

async function verifyEntry(entry: unknown, field: string): Promise<DarwinRuntimeManifestEntry> {
  if (typeof entry !== 'object' || entry === null) {
    throw new DarwinRuntimeManifestError(`${field} entry must be an object`);
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.path !== 'string' || !isAbsolute(e.path)) {
    throw new DarwinRuntimeManifestError(`${field}.path must be an absolute path, got: ${JSON.stringify(e.path)}`);
  }
  const sha256 = assertDigest(e.sha256, `${field}.sha256`);
  if (typeof e.size !== 'number' || !Number.isInteger(e.size) || e.size < 0) {
    throw new DarwinRuntimeManifestError(`${field}.size must be a non-negative integer, got: ${JSON.stringify(e.size)}`);
  }
  if (typeof e.mode !== 'number' || !Number.isInteger(e.mode) || e.mode < 0) {
    throw new DarwinRuntimeManifestError(`${field}.mode must be a non-negative integer, got: ${JSON.stringify(e.mode)}`);
  }

  let st;
  try {
    st = await stat(e.path);
  } catch {
    throw new DarwinRuntimeManifestError(`${field}.path does not exist: ${e.path}`);
  }
  const actualMode = st.mode & 0o7777;
  if (actualMode !== e.mode) {
    throw new DarwinRuntimeManifestError(
      `${field}.mode mismatch for ${e.path}: manifest ${e.mode.toString(8)}, actual ${actualMode.toString(8)}`,
    );
  }
  if ((actualMode & FORBIDDEN_MODE_BITS) !== 0) {
    throw new DarwinRuntimeManifestError(
      `${field}.mode for ${e.path} has setuid/setgid/sticky or group/other write bits: ${actualMode.toString(8)}`,
    );
  }
  if (st.size !== e.size) {
    throw new DarwinRuntimeManifestError(`${field}.size mismatch for ${e.path}: manifest ${e.size}, actual ${st.size}`);
  }
  const actualDigest = await hashFile(e.path);
  if (actualDigest !== sha256) {
    throw new DarwinRuntimeManifestError(`${field}.sha256 mismatch for ${e.path}: digest does not match manifest`);
  }
  return { path: e.path, sha256, size: e.size, mode: e.mode };
}

/**
 * Load and verify a Darwin runtime manifest from disk. Throws
 * DarwinRuntimeManifestError on any schema, digest, size, or mode mismatch.
 * Returns a deeply frozen manifest on success.
 */
export async function verifyDarwinRuntimeManifest(manifestPath: string): Promise<DarwinRuntimeManifest> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    throw new DarwinRuntimeManifestError(`cannot read manifest: ${manifestPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DarwinRuntimeManifestError(`manifest is not valid JSON: ${manifestPath}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new DarwinRuntimeManifestError('manifest must be a JSON object');
  }
  const m = parsed as Record<string, unknown>;

  if (m.schemaVersion !== 1) {
    throw new DarwinRuntimeManifestError(`unsupported schemaVersion: ${JSON.stringify(m.schemaVersion)} (expected 1)`);
  }
  if (typeof m.executablePath !== 'string' || !isAbsolute(m.executablePath)) {
    throw new DarwinRuntimeManifestError(`executablePath must be absolute, got: ${JSON.stringify(m.executablePath)}`);
  }
  if (m.jitPolicy !== 'jitless' && m.jitPolicy !== 'dynamic-code-generation') {
    throw new DarwinRuntimeManifestError(
      `jitPolicy must be "jitless" or "dynamic-code-generation", got: ${JSON.stringify(m.jitPolicy)}`,
    );
  }

  const exeSha = assertDigest(m.sha256, 'sha256');
  if (typeof m.size !== 'number' || !Number.isInteger(m.size) || m.size < 0) {
    throw new DarwinRuntimeManifestError(`size must be a non-negative integer`);
  }
  if (typeof m.mode !== 'number' || !Number.isInteger(m.mode) || m.mode < 0) {
    throw new DarwinRuntimeManifestError(`mode must be a non-negative integer`);
  }
  // Verify the executable itself via the shared entry logic.
  await verifyEntry({ path: m.executablePath, sha256: exeSha, size: m.size, mode: m.mode }, 'executable');

  if (!Array.isArray(m.dylibs)) {
    throw new DarwinRuntimeManifestError('dylibs must be an array');
  }
  if (!Array.isArray(m.dataFiles)) {
    throw new DarwinRuntimeManifestError('dataFiles must be an array');
  }
  if (!Array.isArray(m.machServices)) {
    throw new DarwinRuntimeManifestError('machServices must be an array');
  }
  if (!Array.isArray(m.sysctls)) {
    throw new DarwinRuntimeManifestError('sysctls must be an array');
  }

  const dylibs: DarwinRuntimeManifestEntry[] = [];
  for (let i = 0; i < m.dylibs.length; i++) {
    dylibs.push(await verifyEntry(m.dylibs[i], `dylibs[${i}]`));
  }
  const dataFiles: DarwinRuntimeManifestEntry[] = [];
  for (let i = 0; i < m.dataFiles.length; i++) {
    dataFiles.push(await verifyEntry(m.dataFiles[i], `dataFiles[${i}]`));
  }
  const machServices = (m.machServices as unknown[]).map((s) => assertExactName(s, 'machServices'));
  const sysctls = (m.sysctls as unknown[]).map((s) => assertExactName(s, 'sysctls'));

  const result: DarwinRuntimeManifest = {
    schemaVersion: 1,
    executablePath: m.executablePath,
    sha256: exeSha,
    size: m.size,
    mode: m.mode,
    dylibs,
    dataFiles,
    machServices,
    sysctls,
    jitPolicy: m.jitPolicy,
  };
  Object.freeze(dylibs);
  Object.freeze(dataFiles);
  Object.freeze(machServices);
  Object.freeze(sysctls);
  for (const d of dylibs) Object.freeze(d);
  for (const d of dataFiles) Object.freeze(d);
  return Object.freeze(result);
}

/**
 * Node arguments implied by the manifest's JIT policy. `jitless` maps to the
 * trusted `--jitless` flag; `dynamic-code-generation` maps to no extra args.
 */
export function darwinRuntimeNodeArgs(m: DarwinRuntimeManifest): string[] {
  return m.jitPolicy === 'jitless' ? ['--jitless'] : [];
}
