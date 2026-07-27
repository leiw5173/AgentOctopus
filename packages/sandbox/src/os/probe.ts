/**
 * OS capability probe (Plan 4, Task 1).
 *
 * Determines, with REAL kernel operations, whether this host can grant
 * Linux-namespace + cgroup-v2 isolation (`full`) or must fall back to
 * `restricted`. Never trusts binary presence or version strings — every
 * capability bit is set only after the corresponding privileged operation
 * succeeded AND was cleaned up. Any probe or cleanup failure lands in
 * `probeErrors`, which forces `fullLevel()` to return `'restricted'`.
 *
 * On non-Linux hosts (macOS dev machines) the probe short-circuits WITHOUT
 * touching any kernel object; every capability bit is false.
 *
 * Leaf-package rule: Node stdlib only. execFile argument arrays only —
 * never shell interpolation.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);

export type OsPlatform = 'linux' | 'darwin' | 'other';

export interface OsCaps {
  platform: OsPlatform;
  userMountPidIpcUtsNs: boolean;
  namedNetns: boolean;
  nftRuleCreate: boolean;
  cgroupV2Writable: boolean;
  runtimeArtifact: boolean;
  helperArtifact: boolean;
  sandboxExec: boolean;
  probeErrors: string[];
}

export interface ProbeOptions {
  runtimeManifestPath: string;
  helperManifestPath: string;
  /** Override the parent dir for probe artifacts; default `/run/agentoctopus-probe` (Linux). */
  probeRoot?: string;
}

export function fullLevel(caps: OsCaps): 'full' | 'restricted' {
  const all = caps.platform === 'linux'
    && caps.userMountPidIpcUtsNs
    && caps.namedNetns
    && caps.nftRuleCreate
    && caps.cgroupV2Writable
    && caps.runtimeArtifact
    && caps.helperArtifact
    && caps.probeErrors.length === 0;
  return all ? 'full' : 'restricted';
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

function detectPlatform(): OsPlatform {
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'darwin') return 'darwin';
  return 'other';
}

// ---------------------------------------------------------------------------
// Artifact verification seam
// ---------------------------------------------------------------------------
// Task 2/3 will implement the full ELF/tree/manifest verification in
// `src/os/rootfs.ts` (runtime) and the helper module. For Task 1 we only
// validate that each manifest exists, parses as JSON, has a plausible shape
// (`files` array of `{path, sha256}` entries with valid digest shape), and
// contains no absolute or `..` paths. This is intentionally minimal — the
// real schema/ELF/digest logic is Task 2/3's job and will replace this seam.
//
// When `rootfs.ts` ships, swap `verifyArtifactSeam` for the real
// `verifyRuntimeArtifact` / `verifyHelperArtifact` and the call sites below
// continue to work unchanged.

const SHA256_RE = /^[0-9a-f]{64}$/;

interface ManifestFileEntry {
  path?: unknown;
  sha256?: unknown;
  mode?: unknown;
  size?: unknown;
}

interface ArtifactManifestShape {
  files?: unknown;
}

async function verifyArtifactSeam(manifestPath: string, kind: 'runtime' | 'helper'): Promise<void> {
  const st = await stat(manifestPath);
  if (!st.isFile()) throw new Error(`${kind} manifest is not a regular file: ${manifestPath}`);

  const raw = await readFile(manifestPath, 'utf8');
  let parsed: ArtifactManifestShape;
  try {
    parsed = JSON.parse(raw) as ArtifactManifestShape;
  } catch (err) {
    throw new Error(`${kind} manifest is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${kind} manifest is not a JSON object`);
  }
  const files = parsed.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`${kind} manifest has no files[] entries`);
  }
  for (const entry of files as ManifestFileEntry[]) {
    if (!entry || typeof entry !== 'object') throw new Error(`${kind} manifest has non-object file entry`);
    if (typeof entry.path !== 'string' || entry.path.length === 0) {
      throw new Error(`${kind} manifest file entry missing path`);
    }
    // Manifest paths are relative to the artifact root — reject absolute / traversal.
    if (entry.path.startsWith('/') || entry.path.split('/').includes('..')) {
      throw new Error(`${kind} manifest file entry has unsafe path: ${entry.path}`);
    }
    if (typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256)) {
      throw new Error(`${kind} manifest file entry has invalid sha256 for ${entry.path}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Phase helpers
// ---------------------------------------------------------------------------

interface RunOut { stdout: string; stderr: string; code: number }

async function runArgv(argv: string[], timeoutMs = 15_000): Promise<RunOut> {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error('empty argv');
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: timeoutMs });
    return { stdout: String(stdout), stderr: String(stderr), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? e.message ?? ''),
      code: typeof e.code === 'number' ? e.code : -1,
    };
  }
}

function newToken(): string {
  // 12 hex chars — collision-resistant enough for unique netns/nft/cgroup names
  // within a single boot, and short enough to satisfy kernel name limits
  // (netns name <= 15, nft table <= 256, cgroup dir path).
  return randomBytes(6).toString('hex');
}

// ---------------------------------------------------------------------------
// Phase 1: artifact verification (seam — see comment above)
// ---------------------------------------------------------------------------

async function probeArtifacts(opts: ProbeOptions, errors: string[]): Promise<{ runtime: boolean; helper: boolean }> {
  let runtime = false;
  let helper = false;
  try {
    await verifyArtifactSeam(opts.runtimeManifestPath, 'runtime');
    runtime = true;
  } catch (err) {
    errors.push(`runtime artifact: ${(err as Error).message}`);
  }
  try {
    await verifyArtifactSeam(opts.helperManifestPath, 'helper');
    helper = true;
  } catch (err) {
    errors.push(`helper artifact: ${(err as Error).message}`);
  }
  return { runtime, helper };
}

// ---------------------------------------------------------------------------
// Phase 2: helper-driven user/mount/PID/IPC/UTS namespace probe
// ---------------------------------------------------------------------------
// The verified helper is invoked with `--probe-namespaces`; it performs the
// unshare(2) calls itself inside a tightly-scoped binary so we don't hand
// namespace-creation primitives to the JS layer. The helper path is the
// manifest's declared `helper` entry; Task 3 supplies it. Until then, the
// manifest seam yields the helper entrypoint path.

async function helperPathFromManifest(manifestPath: string): Promise<string> {
  const raw = await readFile(manifestPath, 'utf8');
  const parsed = JSON.parse(raw) as { helper?: unknown; files?: Array<{ path?: unknown }> };
  if (typeof parsed.helper === 'string' && parsed.helper.length > 0) return parsed.helper;
  // Fallback: look for a well-known helper entry in files[].
  const hit = Array.isArray(parsed.files)
    ? parsed.files.find((f) => typeof f?.path === 'string' && /(^|\/)sandbox-helper$/.test(f.path as string))
    : undefined;
  if (hit && typeof hit.path === 'string') return hit.path as string;
  throw new Error('helper manifest does not declare a helper entrypoint');
}

async function probeNamespaces(helperManifestPath: string, manifestDir: string, errors: string[]): Promise<boolean> {
  try {
    const helperRel = await helperPathFromManifest(helperManifestPath);
    const helperAbs = resolve(manifestDir, helperRel);
    const res = await runArgv([helperAbs, '--probe-namespaces']);
    if (res.code !== 0) {
      errors.push(`helper namespace probe exited ${res.code}: ${res.stderr.trim() || res.stdout.trim()}`);
      return false;
    }
    return true;
  } catch (err) {
    errors.push(`helper namespace probe: ${(err as Error).message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Phase 3: named netns create + loopback-up + delete
// ---------------------------------------------------------------------------

async function probeNetns(token: string, errors: string[]): Promise<boolean> {
  const name = `ao-probe-${token}`; // <= 15 chars
  let created = false;
  try {
    const add = await runArgv(['ip', 'netns', 'add', name]);
    if (add.code !== 0) {
      errors.push(`ip netns add: ${add.stderr.trim()}`);
      return false;
    }
    created = true;
    const lo = await runArgv(['ip', 'netns', 'exec', name, 'ip', 'link', 'set', 'lo', 'up']);
    if (lo.code !== 0) {
      errors.push(`ip netns exec lo up: ${lo.stderr.trim()}`);
      return false;
    }
    return true;
  } finally {
    if (created) {
      const del = await runArgv(['ip', 'netns', 'delete', name]);
      if (del.code !== 0) errors.push(`ip netns delete ${name}: ${del.stderr.trim()}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 4: nft inet table + drop-policy base chain + list + delete
// ---------------------------------------------------------------------------

async function probeNft(token: string, errors: string[]): Promise<boolean> {
  const table = `aoprobe${token}`; // nft identifiers are alphanumeric+underscore
  let created = false;
  try {
    const add = await runArgv(['nft', 'add', 'table', 'inet', table]);
    if (add.code !== 0) {
      errors.push(`nft add table: ${add.stderr.trim()}`);
      return false;
    }
    created = true;
    const chain = await runArgv([
      'nft', 'add', 'chain', 'inet', table, 'input',
      '{', 'type', 'filter', 'hook', 'input', 'priority', '0', ';', 'policy', 'drop', ';', '}',
    ]);
    if (chain.code !== 0) {
      errors.push(`nft add chain: ${chain.stderr.trim()}`);
      return false;
    }
    const list = await runArgv(['nft', 'list', 'table', 'inet', table]);
    if (list.code !== 0 || !list.stdout.includes(table)) {
      errors.push(`nft list table missing ${table}: ${list.stderr.trim()}`);
      return false;
    }
    return true;
  } finally {
    if (created) {
      const del = await runArgv(['nft', 'delete', 'table', 'inet', table]);
      if (del.code !== 0) errors.push(`nft delete table ${table}: ${del.stderr.trim()}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 5: cgroup v2 create + write/read memory.max / pids.max / cpu.max + remove
// ---------------------------------------------------------------------------

const CGROUP_ROOT = '/sys/fs/cgroup';

async function readCgroupFile(path: string): Promise<string> {
  const r = await runArgv(['cat', path]);
  if (r.code !== 0) throw new Error(`read ${path}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

async function writeCgroupFile(path: string, value: string): Promise<void> {
  // Use `tee` via execFile argument array — no shell, no interpolation.
  // We pipe via stdin by spawning `tee <path>` and writing value to stdin.
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = execFile('tee', [path], (err) => {
      if (err) rejectPromise(new Error(`write ${path}: ${err.message}`));
      else resolvePromise();
    });
    child.stdin?.write(value);
    child.stdin?.end();
  });
}

async function probeCgroup(token: string, errors: string[]): Promise<boolean> {
  const dir = `${CGROUP_ROOT}/agentoctopus-probe-${token}`;
  let created = false;
  try {
    const mkdir = await runArgv(['mkdir', dir]);
    if (mkdir.code !== 0) {
      errors.push(`cgroup mkdir: ${mkdir.stderr.trim()}`);
      return false;
    }
    created = true;

    // memory.max
    await writeCgroupFile(`${dir}/memory.max`, '134217728'); // 128 MiB
    const mem = await readCgroupFile(`${dir}/memory.max`);
    if (mem !== '134217728') throw new Error(`memory.max readback got ${mem}`);

    // pids.max
    await writeCgroupFile(`${dir}/pids.max`, '64');
    const pids = await readCgroupFile(`${dir}/pids.max`);
    if (pids !== '64') throw new Error(`pids.max readback got ${pids}`);

    // cpu.max ("MAX PERIOD" format)
    await writeCgroupFile(`${dir}/cpu.max`, '50000 100000');
    const cpu = await readCgroupFile(`${dir}/cpu.max`);
    if (!/^(\d+|max)\s+\d+$/.test(cpu)) throw new Error(`cpu.max readback got ${cpu}`);

    // cgroup.kill must exist for safe teardown semantics.
    const killStat = await runArgv(['test', '-f', `${dir}/cgroup.kill`]);
    if (killStat.code !== 0) throw new Error('cgroup.kill not present');

    return true;
  } catch (err) {
    errors.push(`cgroup probe: ${(err as Error).message}`);
    return false;
  } finally {
    if (created) {
      const rmdir = await runArgv(['rmdir', dir]);
      if (rmdir.code !== 0) errors.push(`cgroup rmdir ${dir}: ${rmdir.stderr.trim()}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Real privileged capability probe. Returns `OsCaps` describing every feature
 * the host actually proved it can do, with cleanup guaranteed per phase.
 *
 * On non-Linux: short-circuits to a restricted-grade OsCaps without touching
 * any kernel object. `sandboxExec` is still reported (informational — macOS
 * sandbox-exec presence does NOT confer `full`).
 */
export async function probeOsCaps(opts: ProbeOptions): Promise<OsCaps> {
  const platform = detectPlatform();
  const probeErrors: string[] = [];

  const caps: OsCaps = {
    platform,
    userMountPidIpcUtsNs: false,
    namedNetns: false,
    nftRuleCreate: false,
    cgroupV2Writable: false,
    runtimeArtifact: false,
    helperArtifact: false,
    sandboxExec: false,
    probeErrors,
  };

  if (platform === 'darwin') {
    // Informational only; macOS remains restricted regardless.
    const se = await runArgv(['/usr/bin/which', 'sandbox-exec']);
    caps.sandboxExec = se.code === 0 && se.stdout.trim().length > 0;
    return caps;
  }
  if (platform !== 'linux') {
    return caps;
  }

  // Linux: perform real probes in order. Each phase is independent; failure
  // of one does not prevent the others from running, because partial info
  // still helps diagnostics — but fullLevel() will not grant `full`.
  const token = newToken();

  const artifacts = await probeArtifacts(opts, probeErrors);
  caps.runtimeArtifact = artifacts.runtime;
  caps.helperArtifact = artifacts.helper;

  // Helper namespace probe needs the helper manifest dir to resolve relative paths.
  const helperManifestDir = resolve(opts.helperManifestPath, '..');
  caps.userMountPidIpcUtsNs = await probeNamespaces(opts.helperManifestPath, helperManifestDir, probeErrors);

  caps.namedNetns = await probeNetns(token, probeErrors);
  caps.nftRuleCreate = await probeNft(token, probeErrors);
  caps.cgroupV2Writable = await probeCgroup(token, probeErrors);

  return caps;
}
