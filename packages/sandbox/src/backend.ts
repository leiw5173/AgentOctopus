import type { BackendKind, IsolationLevel, SandboxResultMeta } from './types.js';
import type { SandboxPolicy } from './policy.js';
import type { SandboxConfig } from './schema.js';

/** Trusted runtime profile selected from canonical config, never from skill input. */
export interface ResolvedRuntimeProfile {
  readonly id: string;
  readonly bins: string[];
  readonly path: string;
  readonly dockerImage?: string;
  readonly osRuntime?: {
    artifactPath: string;
    manifestPath: string;
    nodePath: '/usr/bin/node' | '/bin/node' | '/usr/local/bin/node';
  };
}

/**
 * Coordinates created before proxy launch and owned by backend cleanup.
 * Canonical across all plans — do not add optional fields or rename `kind`.
 */
export type ProxyCarrier =
  | { kind: 'in-process'; listenHost: string; reachableHost: string }
  | {
      kind: 'docker-sidecar';
      proxyImage: string;
      internalNetwork: string;
      egressNetwork: string;
      reachableHost: string;
    }
  | {
      kind: 'linux-static';
      binaryPath: string;
      skillNamespace: { name: string; path: string };
      listenHost: string;
      reachableHost: string;
      cgroupPath: string;
      listenPort: number;
    };

/**
 * A command to execute inside the sandbox.
 * `stdin` is the one-shot payload for `run()`; `run()` writes it then closes stdin.
 * `spawn()` ignores `stdin` and always exposes a writable stdin pipe.
 */
export interface ExecSpec {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  outputMaxBytes?: number;
}

/** Persistent execution always exposes a writable stdin pipe (no payload). */
export interface SpawnSpec extends Omit<ExecSpec, 'stdin'> {
  stdin?: 'pipe';
}

export interface BackendRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  meta: SandboxResultMeta;
}

export interface SandboxProcess {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  readonly exited: Promise<BackendRunResult>;
  kill(signal?: NodeJS.Signals): Promise<void>;
  close(): Promise<void>;
}

/**
 * The one canonical prepare input. Policy fields stay flattened so the resolved
 * policy remains the source of truth. Proxy and CA values are mandatory because
 * DefaultProxyLauncher always creates a per-session handle, including deny-all
 * sessions. Guest mount paths are literal contracts shared by every backend.
 */
export interface BackendPrepareOptions extends SandboxPolicy {
  snapshotRoot: string;
  proxyAddr: string;
  caBundlePath: string;
  runtimeProfile: ResolvedRuntimeProfile;
  guestSkillRoot: '/skill';
  guestCaBundlePath: '/etc/skill-ca/ca.pem';
}

export interface SandboxBackend {
  readonly kind: BackendKind;
  readonly isolationLevel: IsolationLevel;
  /** Self-cleaning capability probe: verifies real privileges, restores state. */
  probe(): Promise<boolean>;
  /** Create backend topology before proxy launch; no skill code executes here. */
  prepareTopology(): Promise<ProxyCarrier>;
  /** Mount/configure the verified snapshot, launched proxy, CA, and runtime. */
  prepare(opts: BackendPrepareOptions): Promise<void>;
  /** Launch one persistent duplex child. */
  spawn(spec: SpawnSpec): Promise<SandboxProcess>;
  /** Implement as spawn/write-or-end/await exited/close. */
  run(spec: ExecSpec): Promise<BackendRunResult>;
  /** Idempotent; owns topology attachments/networks plus backend runtime state. */
  cleanup(): Promise<void>;
}

export class NoFullBackendError extends Error {
  constructor(msg = 'no backend meets the required isolation level') { super(msg); }
}

const LEVEL_RANK: Record<IsolationLevel, number> = {
  full: 3, restricted: 2, 'remote-unverified': 1, none: 0,
};

/**
 * Fail-closed backend selection (spec §7): in `auto` mode, choose a backend
 * whose isolationLevel meets `minIsolationLevel` AND whose probe passes. Never
 * silently degrade to a weaker backend — refuse instead.
 *
 * Probing happens BEFORE the isolationLevel rank check: a backend may start
 * at `restricted` and only reach `full` after a live capability probe (e.g.
 * the OS backend). Ranking before probing would drop such a backend and never
 * observe its promoted level, so the probe runs first and the post-probe
 * `isolationLevel` is what's ranked. Fail-closed is preserved: a backend whose
 * probe fails OR whose post-probe level still falls short is excluded.
 */
export async function selectBackend(config: SandboxConfig, available: SandboxBackend[]): Promise<SandboxBackend> {
  const required = LEVEL_RANK[config.minIsolationLevel];

  const candidates: SandboxBackend[] = [];
  for (const b of available) {
    if (config.defaultBackend !== 'auto' && b.kind !== config.defaultBackend) continue;
    // Probe FIRST: a backend may promote its isolationLevel from restricted to
    // full only after a live capability check. Ranking before probing would
    // drop it and never observe the promoted level.
    if (!(await b.probe())) continue; // probe failed — excluded
    if (LEVEL_RANK[b.isolationLevel] < required) continue; // still too weak post-probe
    candidates.push(b);
  }

  // Prefer the strongest available (full > restricted > ...).
  candidates.sort((a, b) => LEVEL_RANK[b.isolationLevel] - LEVEL_RANK[a.isolationLevel]);
  const chosen = candidates[0];
  if (!chosen) {
    throw new NoFullBackendError(
      `no sandbox backend meets isolationLevel >= ${config.minIsolationLevel} (fail-closed)`,
    );
  }
  return chosen;
}
