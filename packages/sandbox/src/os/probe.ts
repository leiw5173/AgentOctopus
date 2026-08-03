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
import { stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { verifyRuntimeArtifact } from './rootfs.js';
import { verifyHelperArtifact } from './helper-build.js';

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
  /**
   * Absolute path to the already-resolved helper binary. When provided, the
   * helper artifact is verified with the real `verifyHelperArtifact()` (strict
   * digest/size/mode) and the namespace probe executes THIS binary. When
   * omitted, the path is derived from the manifest filename convention
   * (`<name>.manifest.json` → sibling `<name>` binary) — still verified.
   */
  helperBinaryPath?: string;
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
// Artifact verification (Task 2 runtime seam + Task 3 real helper verifier)
// ---------------------------------------------------------------------------
// The runtime manifest is verified by `verifyRuntimeArtifact()`; the helper by
// `verifyHelperArtifact()` (strict digest/size/mode, no files[] indirection).
//
// Manifest naming convention (Task 2.5): the runtime manifest is
//   <dir>/linux-node22.manifest.json     artifact: <dir>/linux-node22.rootfs.tar.zst
// The probe derives the runtime artifact path from the manifest filename so
// callers only need to pass the manifest path. If the manifest filename does
// not match the convention, the probe reports the artifact as missing
// (fail-closed) rather than guess.

/** Derive the sibling runtime artifact path from a Task 2.5 manifest path. */
function runtimeArtifactPathFromManifest(manifestPath: string): string {
  const dir = dirname(manifestPath);
  const base = basename(manifestPath);
  // <name>.manifest.json -> <name>.rootfs.tar.zst
  const m = base.match(/^(.+)\.manifest\.json$/);
  if (!m) throw new Error(`runtime manifest filename does not match *.manifest.json: ${base}`);
  return join(dir, `${m[1]}.rootfs.tar.zst`);
}

async function verifyRuntimeSeam(manifestPath: string): Promise<void> {
  const st = await stat(manifestPath);
  if (!st.isFile()) throw new Error(`runtime manifest is not a regular file: ${manifestPath}`);
  const artifactPath = runtimeArtifactPathFromManifest(manifestPath);
  await verifyRuntimeArtifact({ artifactPath, manifestPath });
}

/**
 * Derive the helper binary path: the caller's resolved `helperBinaryPath`
 * wins; otherwise the manifest filename convention (`<name>.manifest.json`
 * → sibling `<name>`). Either way the binary is verified against the manifest
 * by `verifyHelperArtifact()` before it is ever executed.
 */
function helperBinaryPathFromManifest(helperManifestPath: string, override?: string): string {
  if (override && override.length > 0) return override;
  const dir = dirname(helperManifestPath);
  const base = basename(helperManifestPath);
  const m = base.match(/^(.+)\.manifest\.json$/);
  if (!m) throw new Error(`helper manifest filename does not match *.manifest.json: ${base}`);
  return join(dir, m[1]);
}

async function verifyHelperSeam(helperManifestPath: string, helperBinaryPath: string): Promise<void> {
  const st = await stat(helperManifestPath);
  if (!st.isFile()) throw new Error(`helper manifest is not a regular file: ${helperManifestPath}`);
  await verifyHelperArtifact({ helperPath: helperBinaryPath, manifestPath: helperManifestPath });
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
// Phase 1: artifact verification (runtime + helper, both real verifiers)
// ---------------------------------------------------------------------------

async function probeArtifacts(opts: ProbeOptions, errors: string[]): Promise<{ runtime: boolean; helper: boolean }> {
  let runtime = false;
  let helper = false;
  try {
    await verifyRuntimeSeam(opts.runtimeManifestPath);
    runtime = true;
  } catch (err) {
    errors.push(`runtime artifact: ${(err as Error).message}`);
  }
  try {
    await verifyHelperSeam(opts.helperManifestPath, helperBinaryPathFromManifest(opts.helperManifestPath, opts.helperBinaryPath));
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
// namespace-creation primitives to the JS layer. The helper binary path is
// resolved by the caller (OsSandboxBackend.resolveOsArtifacts) or derived from
// the manifest filename convention, and is always digest/size/mode-verified
// by Phase 1 before it is executed here.

async function probeNamespaces(helperBinaryPath: string, errors: string[]): Promise<boolean> {
  try {
    const res = await runArgv([helperBinaryPath, '--probe-namespaces']);
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

  // Namespace probe executes the verified helper binary (Phase 1 verified it
  // above). If the helper artifact failed verification, skip execution —
  // never run an unverified helper.
  if (artifacts.helper) {
    caps.userMountPidIpcUtsNs = await probeNamespaces(
      helperBinaryPathFromManifest(opts.helperManifestPath, opts.helperBinaryPath),
      probeErrors,
    );
  } else {
    probeErrors.push('namespace probe skipped: helper artifact failed verification');
  }

  caps.namedNetns = await probeNetns(token, probeErrors);
  caps.nftRuleCreate = await probeNft(token, probeErrors);
  caps.cgroupV2Writable = await probeCgroup(token, probeErrors);

  return caps;
}
