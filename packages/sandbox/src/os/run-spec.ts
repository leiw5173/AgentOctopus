/**
 * Plan 4, Task 3 — OS-backend launch-spec serializer.
 *
 * `buildOsRunCommand()` produces the direct argv for the digest-verified
 * phased helper. It NEVER emits shell text: the helper is invoked with
 * argument-array semantics (`--launch-spec <path> --stop-before-exec`) and
 * the launch spec is a JSON document written to a root-owned 0600 file.
 *
 * Separation of phases is enforced structurally:
 *   - The spec carries HOST paths (`hostBinds[].source`, `hostBinds[].target`,
 *     `netnsPath`) for the helper's phase-1/phase-2 work outside the chroot.
 *   - The spec carries IN-ROOT paths (`cwd`, `command[]`) for phase-3 execve.
 *   - Phase-3 paths are validated to never reference the host staging root.
 *
 * The helper artifact pair is re-verified (SHA-256/size/mode) immediately
 * before the launch spec is written, so a tampered helper can never be
 * exec'd. There is no caching of the verification result.
 *
 * Leaf-package rule: Node stdlib only (zod via helper-build).
 */

import crypto from 'node:crypto';
import { chmod, mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyHelperArtifact } from './helper-build.js';
import type { RootfsLayout } from './rootfs.js';
import type { NetnsHandle } from './netns.js';
import type { ExecSpec } from '../backend.js';

export class RunSpecError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RunSpecError';
  }
}

// ---------------------------------------------------------------------------
// Public contracts
// ---------------------------------------------------------------------------

export interface HelperLaunchSpec {
  /** Host path of the verified runtime/chroot staging root. */
  root: string;
  /** Host path to the named netns fd (e.g. `/run/netns/octn-deadbeef`). */
  netnsPath: string;
  /** Host-path bind mounts performed BEFORE chroot (phase 1). */
  hostBinds: Array<{ source: string; target: string; recursive: boolean }>;
  /** Size of the private tmpfs mounted on `<root>/tmp`. */
  tmpSizeBytes: number;
  /** Size of the private tmpfs mounted on `<root>/dev`. */
  devSizeBytes: number;
  /** UID the untrusted process drops to (typically 65534). */
  uid: number;
  /** GID the untrusted process drops to (typically 65534). */
  gid: number;
  /** IN-ROOT working directory for execve (e.g. `/skill`). */
  cwd: string;
  /** IN-ROOT argv for execve — NEVER a host path. */
  command: string[];
  /** Allowlisted environment installed after the env is cleared. */
  env: Record<string, string>;
}

export interface OsRunCommand {
  /** Absolute path of the digest-verified helper binary. */
  file: string;
  /** Direct argv — no shell, no interpolation. */
  args: string[];
  /** Environment for the LAUNCHER (root) process; the helper clears env in phase 3. */
  env: Record<string, string>;
  /** Absolute path of the root-owned 0600 launch spec. */
  launchSpecPath: string;
}

// ---------------------------------------------------------------------------
// Defaults (per the binding constraints)
// ---------------------------------------------------------------------------

const UNTRUSTED_UID = 65534;
const UNTRUSTED_GID = 65534;
const TMP_SIZE_BYTES = 64 * 1024 * 1024; // 64 MiB private /tmp
const DEV_SIZE_BYTES = 4 * 1024 * 1024;  // 4 MiB private /dev

// Environment the untrusted process is allowed to see. Everything else is
// cleared by the helper in phase 3. Proxy variables point at the in-netns
// egress proxy so the skill can only reach the allowlisted endpoints.
function buildAllowlistedEnv(proxyAddr: string, spec: ExecSpec): Record<string, string> {
  const env: Record<string, string> = {
    PATH: '/usr/bin:/bin',
    HOME: '/tmp',
    TMPDIR: '/tmp',
    HTTP_PROXY: proxyAddr,
    HTTPS_PROXY: proxyAddr,
    http_proxy: proxyAddr,
    https_proxy: proxyAddr,
    NO_PROXY: 'localhost,127.0.0.1,169.254.0.0/16',
    no_proxy: 'localhost,127.0.0.1,169.254.0.0/16',
  };
  // Caller-supplied env is filtered: only a small set of obviously-safe
  // pass-throughs is allowed, and proxy variables can never be overridden.
  if (spec.env) {
    const SAFE = new Set(['LANG', 'LC_ALL', 'TZ', 'TERM', 'NODE_ENV']);
    for (const [k, v] of Object.entries(spec.env)) {
      if (SAFE.has(k)) env[k] = v;
    }
  }
  return env;
}

// ---------------------------------------------------------------------------
// Validation — fail closed on any host-path leakage into phase 3.
// ---------------------------------------------------------------------------

function assertInRootPath(p: string, what: string, layout: RootfsLayout): void {
  if (!p.startsWith('/')) {
    throw new RunSpecError(`${what} must be an absolute in-root path, got '${p}'`);
  }
  if (p.includes('..')) {
    throw new RunSpecError(`${what} must not contain '..', got '${p}'`);
  }
  // Never allow a phase-3 path to reference the host staging root.
  if (p === layout.root || p.startsWith(layout.root + '/')) {
    throw new RunSpecError(
      `${what} references the host staging root ('${p}' is under '${layout.root}') — phase-3 paths must be in-root only`,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildOsRunCommandOptions {
  helperPath: string;
  helperManifestPath: string;
  layout: RootfsLayout;
  netns: NetnsHandle;
  spec: ExecSpec;
  /** Proxy address reachable from INSIDE the netns (e.g. `http://169.254.7.1:43123`). */
  proxyAddr: string;
  /**
   * Directory the 0600 launch spec is written into. Defaults to a fresh
   * mkdtemp under os.tmpdir(). The directory is created 0700 and the spec
   * file 0600; both are owned by the launching (root) user.
   */
  specDir?: string;
}

/**
 * Verify the helper artifact pair, serialize the launch spec to a root-owned
 * 0600 file, and return the direct helper argv. Never emits shell text.
 *
 * The returned `args` are exactly `['--launch-spec', launchSpecPath,
 * '--stop-before-exec']` — the helper PARENT raises SIGSTOP before its
 * phase-1 setup so the cgroup can attach the spawned pid, then SIGCONT runs
 * all setup + fork + execve inside the cgroup (the untrusted child inherits
 * the cgroup at fork()).
 */
export async function buildOsRunCommand(
  opts: BuildOsRunCommandOptions,
): Promise<OsRunCommand> {
  const { helperPath, helperManifestPath, layout, netns, spec, proxyAddr } = opts;

  // Verify the helper artifact immediately before launch. Any tampering
  // between build and launch is caught here; the check is never cached.
  await verifyHelperArtifact({ helperPath, manifestPath: helperManifestPath });

  if (!Array.isArray(spec.command) || spec.command.length === 0) {
    throw new RunSpecError('spec.command must be a non-empty array');
  }
  for (const arg of spec.command) {
    if (typeof arg !== 'string' || arg.length === 0) {
      throw new RunSpecError('spec.command entries must be non-empty strings');
    }
  }

  // Phase-3 paths: cwd and command[0] must be in-root absolute paths that
  // never reference the host staging root.
  const cwd = spec.cwd ?? layout.inRoot.skill;
  assertInRootPath(cwd, 'cwd', layout);
  assertInRootPath(spec.command[0], 'command[0]', layout);
  for (let i = 1; i < spec.command.length; i++) {
    const a = spec.command[i];
    if (a.startsWith('/')) assertInRootPath(a, `command[${i}]`, layout);
  }

  // Host-path bind mounts for phase 1. The runtime root binds onto itself
  // (remounted RO); the snapshot and CA bind to their mount targets.
  const hostBinds: HelperLaunchSpec['hostBinds'] = [
    { source: layout.runtimeRoot, target: layout.runtimeRoot, recursive: true },
    { source: layout.hostMounts.snapshotSource, target: layout.hostMounts.snapshotTarget, recursive: true },
  ];
  if (layout.hostMounts.caSource && layout.hostMounts.caTarget) {
    hostBinds.push({ source: layout.hostMounts.caSource, target: layout.hostMounts.caTarget, recursive: false });
  }

  const launch: HelperLaunchSpec = {
    root: layout.root,
    netnsPath: netns.path,
    hostBinds,
    tmpSizeBytes: TMP_SIZE_BYTES,
    devSizeBytes: DEV_SIZE_BYTES,
    uid: UNTRUSTED_UID,
    gid: UNTRUSTED_GID,
    cwd,
    command: [...spec.command],
    env: buildAllowlistedEnv(proxyAddr, spec),
  };

  // Serialize to a root-owned 0600 file. The directory is 0700.
  const specDir = opts.specDir ?? await mkdtemp(path.join(os.tmpdir(), 'oct-launch-spec-'));
  await chmod(specDir, 0o700).catch(() => {});
  const launchSpecPath = path.join(specDir, `launch-${crypto.randomBytes(8).toString('hex')}.json`);
  const body = JSON.stringify(launch, null, 2) + '\n';
  // O_EXCL so we never overwrite a pre-existing (possibly attacker-planted) file.
  const fh = await open(launchSpecPath, 'wx', 0o600).catch(async (err) => {
    await rm(specDir, { recursive: true, force: true }).catch(() => {});
    throw new RunSpecError(`cannot create launch spec: ${(err as Error).message}`);
  });
  try {
    await fh.writeFile(body, 'utf8');
  } finally {
    await fh.close();
  }
  await chmod(launchSpecPath, 0o600);

  return {
    file: helperPath,
    args: ['--launch-spec', launchSpecPath, '--stop-before-exec'],
    env: {}, // the launcher passes a minimal env; the helper clears env in phase 3
    launchSpecPath,
  };
}

/** Remove the launch-spec file (and its tmp dir if we created it). Idempotent. */
export async function cleanupLaunchSpec(launchSpecPath: string): Promise<void> {
  await rm(launchSpecPath, { force: true }).catch(() => {});
  // Best-effort: remove the parent dir only if it is an oct-launch-spec tmpdir.
  const dir = path.dirname(launchSpecPath);
  if (path.basename(dir).startsWith('oct-launch-spec-')) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
