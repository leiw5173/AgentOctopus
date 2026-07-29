/**
 * SandboxRunner — the SOLE orchestration boundary between a LoadedSkill and a
 * concrete sandbox backend (Plan 5 Task 3). All security invariants live
 * here, in one place, and run() and spawn() share ONE private prepareSession()
 * so MCP (Task 5) cannot drift from one-shot security ordering.
 *
 * Fixed orchestration order (do not reorder):
 *   buildSnapshot(live dir once)
 *   → toSandboxDescriptor(identity.digest)
 *   → resolvePolicy(requested ∩ granted)
 *   → resolve trusted digest-pinned runtime profile for requested bins
 *   → selectBackend(config, available)              [direct return]
 *   → backend.prepareTopology()                     [creates carrier before proxy]
 *   → provisionSecrets                              [ResolvedSecrets]
 *   → mkdtemp private session workDir (0700)        [<store>/sessions/oct-session-*]
 *   → proxyLauncher.launch({ policy, secrets, workDir }, carrier)
 *   → verifySnapshot(snapshotRoot, identity.digest) [immediately before prepare]
 *   → backend.prepare({ ...policy, snapshotRoot, proxyAddr, caBundlePath,
 *                        runtimeProfile, guestSkillRoot:'/skill',
 *                        guestCaBundlePath:'/etc/skill-ca/ca.pem' })
 *   → rewrite command/cwd/env to guest paths
 *   → backend.run or backend.spawn
 *   → deterministic reverse cleanup
 *
 * Cleanup is reverse and idempotent:
 *   spawn() path: process.close() → backend.cleanup() → proxyHandle.close() → rm sessionDir
 *   run()   path: backend.cleanup() → proxyHandle.close() → rm sessionDir
 *   (backend.run() owns its own spawn→write→exited→close lifecycle internally;
 *    the one-shot path has no process handle. Session-dir removal is
 *    best-effort host hygiene, never a containment error.)
 *
 * Env hygiene:
 *   minimal allowlist (LANG, LC_ALL, TZ) + non-reserved caller keys + fixed
 *   guest HOME=/tmp/home, TMPDIR=/tmp, runtime-profile PATH. NEVER spread
 *   process.env. Serialize invocation.payload exactly once to OCTOPUS_INPUT;
 *   REJECT caller attempts to set OCTOPUS_INPUT, proxy/CA/identity/PATH/HOME
 *   variables.
 *
 * Path rewriting:
 *   relative skill paths (scripts/invoke.js, ./scripts/invoke.js, abs paths
 *   under skill.dirPath) → /skill/...; cwd:'/skill'. REJECT any command
 *   escaping /skill or any live-dir path not under the snapshot. No live dir
 *   may appear in ExecSpec.
 */
import path from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import type { LoadedSkill } from '@agentoctopus/registry';
import { lookupInstallationId } from '@agentoctopus/skills';
import {
  buildSnapshot,
  verifySnapshot,
  resolvePolicy,
  selectBackend,
  NoFullBackendError,
  SandboxConfigSchema,
  DefaultProxyLauncher,
  type BackendPrepareOptions,
  type BackendKind,
  type ExecSpec,
  type InstallationIdentity,
  type IsolationLevel,
  type ProxyLauncher,
  type ResolvedRuntimeProfile,
  type SandboxBackend,
  type SandboxConfig,
  type SandboxProcess,
  type SandboxSkillDescriptor,
  type SecretProvider,
  type SpawnSpec,
  type ResolvedSecrets,
  type BackendRunResult,
  MapSecretProvider,
} from '@agentoctopus/sandbox';
import { toSandboxDescriptor } from './sandbox-bridge.js';

// ---------------------------------------------------------------------------
// Public DTOs
// ---------------------------------------------------------------------------

export interface SandboxInvocation {
  payload?: unknown;
  stdin?: string | Uint8Array;
  env?: Record<string, string>;
}

export interface SandboxCommandInput {
  command: string[];
  invocation?: SandboxInvocation;
  timeoutMs?: number;
}

export interface SandboxRunInput extends SandboxCommandInput {
  skill: LoadedSkill;
}

export interface SandboxSpawnInput extends Omit<SandboxRunInput, 'invocation'> {
  invocation?: Omit<SandboxInvocation, 'stdin'>;
}

export interface SandboxRunOutput {
  success: boolean;
  rawText?: string;
  stderr?: string;
  error?: string;
  isolationLevel: IsolationLevel;
  backend: BackendKind | 'none';
}

export interface SandboxSession {
  readonly process: SandboxProcess;
  readonly isolationLevel: IsolationLevel;
  readonly backend: BackendKind;
  close(): Promise<void>;
}

/**
 * Local structural interface used by the adapters package (Task 4 will
 * re-export it from packages/adapters/src/adapter.ts). It uses ONLY
 * primitive/DTO + sandbox contract types — no LoadedSkill import — so the
 * adapter package can consume it without taking a dependency on registry.
 */
export interface BoundSandboxExecutionPort {
  run(input: SandboxCommandInput): Promise<SandboxRunOutput>;
  spawn(
    input: Omit<SandboxCommandInput, 'invocation'> & {
      invocation?: Omit<SandboxInvocation, 'stdin'>;
    },
  ): Promise<SandboxSession>;
}

// ---------------------------------------------------------------------------
// Error codes (machine-readable; tests assert on these)
// ---------------------------------------------------------------------------

export const SANDBOX_ERROR = {
  NO_SATISFYING_BACKEND: 'NO_SATISFYING_BACKEND',
  SNAPSHOT_MISMATCH: 'SNAPSHOT_MISMATCH',
  UNSUPPORTED_RUNTIME_REQUIREMENTS: 'UNSUPPORTED_RUNTIME_REQUIREMENTS',
  INSTALLATION_METADATA_MISSING: 'INSTALLATION_METADATA_MISSING',
  COMMAND_PATH_REJECTED: 'COMMAND_PATH_REJECTED',
  RESERVED_ENV_REJECTED: 'RESERVED_ENV_REJECTED',
} as const;

export type SandboxErrorCode = (typeof SANDBOX_ERROR)[keyof typeof SANDBOX_ERROR];

class SandboxRunnerError extends Error {
  constructor(public readonly code: SandboxErrorCode, message: string) {
    super(`${code}: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// DI seams (test-only overrides). Production callers do NOT set these.
// ---------------------------------------------------------------------------

export interface SandboxRunnerDeps {
  /** Trusted, already-parsed sandbox config. REQUIRED. */
  config: SandboxConfig;
  /** Content-addressed snapshot store dir. REQUIRED — fail fast if absent. */
  snapshotStoreDir: string;
  /** Pre-constructed backends; if omitted, the runner constructs none (fail-closed). */
  backends?: SandboxBackend[];
  /** Proxy launcher; defaults to DefaultProxyLauncher. */
  proxyLauncher?: ProxyLauncher;
  /** Secret provider; defaults to an empty MapSecretProvider (no secrets resolved). */
  secretProvider?: SecretProvider;
  /**
   * Installation-id lookup seam. Defaults to lookupInstallationId (strict read;
   * throws INSTALLATION_ID_MISSING). Absence surfaces as
   * INSTALLATION_METADATA_MISSING. NEVER generates identity during execute.
   */
  installationIdFor?: (dirPath: string) => string;
  /**
   * Test-only event recorder. Receives orchestration events in order so tests
   * can assert on sequencing without mocking internals.
   */
  onEvent?: (name: string, detail?: unknown) => void;
  /**
   * Test-only hook: called immediately after buildSnapshot returns, BEFORE
   * verifySnapshot. Tests use this to mutate the snapshot and trigger
   * SNAPSHOT_MISMATCH. NOT for production use.
   */
  afterBuildSnapshot?: (ctx: { snapshotRoot: string; identity: InstallationIdentity }) => void;
}

// ---------------------------------------------------------------------------
// Env hygiene
// ---------------------------------------------------------------------------

const ENV_ALLOWLIST = new Set(['LANG', 'LC_ALL', 'TZ']);
const ENV_RESERVED = new Set([
  'OCTOPUS_INPUT',
  'PATH',
  'HOME',
  'TMPDIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'OCTOPUS_PROXY_SECRET_FD',
  'OCTOPUS_PROXY_SECRET_NONCE',
  'OCTOPUS_PROXY_CONFIG',
  'OCTOPUS_INSTALLATION_ID',
  'OCTOPUS_SNAPSHOT_REF',
  'OCTOPUS_DIGEST',
]);

function buildGuestEnv(input: {
  callerEnv: Record<string, string> | undefined;
  payload: unknown;
  runtimeProfile: ResolvedRuntimeProfile;
}): Record<string, string> {
  const env: Record<string, string> = {};
  // allowlist
  for (const k of ENV_ALLOWLIST) {
    const v = input.callerEnv?.[k];
    if (v !== undefined) env[k] = v;
  }
  // non-reserved caller keys
  for (const [k, v] of Object.entries(input.callerEnv ?? {})) {
    if (ENV_ALLOWLIST.has(k)) continue;
    if (ENV_RESERVED.has(k)) {
      throw new SandboxRunnerError(
        SANDBOX_ERROR.RESERVED_ENV_REJECTED,
        `caller attempted to set reserved env var ${k}`,
      );
    }
    env[k] = v;
  }
  // fixed guest values
  env.HOME = '/tmp/home';
  env.TMPDIR = '/tmp';
  env.PATH = input.runtimeProfile.path;
  // payload → OCTOPUS_INPUT (exactly once)
  if (input.payload !== undefined) {
    env.OCTOPUS_INPUT = JSON.stringify(input.payload);
  }
  return env;
}

// ---------------------------------------------------------------------------
// Path rewriting
// ---------------------------------------------------------------------------

function rewriteCommand(command: string[], skillDirPath: string): string[] {
  const out: string[] = [];
  const resolvedSkillDir = path.resolve(skillDirPath);
  for (let i = 0; i < command.length; i++) {
    const arg = command[i]!;
    // `-c` (sh/bash -c) marks the NEXT token as an OPAQUE shell string. The
    // payload is a free-form shell command (e.g. `python3 scripts/run.py
    // --fast`, `curl -s https://host/x?a=b`) — NOT a path — so path-rewriting
    // it would corrupt it (e.g. → `/skill/python3 scripts/run.py ...`). Copy
    // the flag through and pass the payload verbatim, then resume rewriting.
    if (arg === '-c') {
      out.push(arg);
      const payload = command[i + 1];
      if (payload !== undefined) {
        out.push(payload);
        i++; // consumed the opaque payload token
      }
      continue;
    }
    // Absolute path under skill.dirPath → /skill/...
    if (path.isAbsolute(arg)) {
      // Already a guest path — pass through unchanged.
      if (arg === '/skill' || arg.startsWith('/skill/')) {
        out.push(arg);
        continue;
      }
      const resolved = path.resolve(arg);
      if (resolved === resolvedSkillDir || resolved.startsWith(resolvedSkillDir + path.sep)) {
        const rel = path.relative(resolvedSkillDir, resolved).split(path.sep).join('/');
        out.push(`/skill${rel ? '/' + rel : ''}`);
        continue;
      }
      // Absolute path NOT under skill.dirPath — reject.
      throw new SandboxRunnerError(
        SANDBOX_ERROR.COMMAND_PATH_REJECTED,
        `absolute command path escapes /skill: ${arg}`,
      );
    }
    // Relative path
    const norm = arg.replace(/\\/g, '/');
    if (norm === '.' || norm === '..') {
      throw new SandboxRunnerError(
        SANDBOX_ERROR.COMMAND_PATH_REJECTED,
        `command path escapes /skill: ${arg}`,
      );
    }
    // Strip leading ./ for canonical form
    const stripped = norm.startsWith('./') ? norm.slice(2) : norm;
    if (stripped.includes('..')) {
      throw new SandboxRunnerError(
        SANDBOX_ERROR.COMMAND_PATH_REJECTED,
        `command path escapes /skill: ${arg}`,
      );
    }
    // Bare binary names (no path separator) are allowed — they resolve via PATH
    if (!stripped.includes('/')) {
      out.push(stripped);
      continue;
    }
    // Relative path with separators → /skill/...
    out.push(`/skill/${stripped}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runtime profile resolution
// ---------------------------------------------------------------------------

function resolveRuntimeProfile(
  config: SandboxConfig,
  descriptor: SandboxSkillDescriptor,
): ResolvedRuntimeProfile {
  const requestedBins = descriptor.request.bins ?? [];
  const profiles = config.runtimeProfiles;

  if (requestedBins.length === 0) {
    // Empty-bins skill: pick the lexicographically-first trusted profile as a
    // deterministic sane default (independent of config-author key insertion order).
    const firstKey = Object.keys(profiles).sort()[0];
    if (!firstKey) {
      throw new SandboxRunnerError(
        SANDBOX_ERROR.UNSUPPORTED_RUNTIME_REQUIREMENTS,
        'no trusted runtime profiles configured',
      );
    }
    const p = profiles[firstKey]!;
    return { id: firstKey, bins: p.bins, path: p.path, dockerImage: p.dockerImage, osRuntime: p.osRuntime };
  }

  for (const [id, p] of Object.entries(profiles)) {
    if (requestedBins.every((b) => p.bins.includes(b))) {
      return { id, bins: p.bins, path: p.path, dockerImage: p.dockerImage, osRuntime: p.osRuntime };
    }
  }

  throw new SandboxRunnerError(
    SANDBOX_ERROR.UNSUPPORTED_RUNTIME_REQUIREMENTS,
    `no single trusted runtime profile covers requested bins: ${requestedBins.join(', ')}`,
  );
}

// ---------------------------------------------------------------------------
// Secret provisioning
// ---------------------------------------------------------------------------

async function provisionSecrets(
  policy: ReturnType<typeof resolvePolicy>,
  identity: InstallationIdentity,
  secretProvider: SecretProvider,
): Promise<ResolvedSecrets> {
  const out: ResolvedSecrets = {};
  for (const grant of policy.credentials) {
    const value = await secretProvider.resolve(identity, grant.key);
    if (value !== undefined) out[grant.key] = value;
  }
  return out;
}

/**
 * Best-effort removal of the per-session working directory. Session-dir
 * removal failure is trusted host filesystem hygiene, NOT skill containment —
 * it is never a ContainmentCleanupError and never throws from cleanup. (T3
 * appends a diagnostic degradation reason; T2 only guarantees best-effort,
 * never-throwing removal.)
 */
async function removeSessionDir(sessionDir: string): Promise<void> {
  await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// SandboxRunner
// ---------------------------------------------------------------------------

export class SandboxRunner {
  private readonly config: SandboxConfig;
  private readonly snapshotStoreDir: string;
  private readonly backends: SandboxBackend[];
  private readonly proxyLauncher: ProxyLauncher;
  private readonly secretProvider: SecretProvider;
  private readonly installationIdFor: (dirPath: string) => string;
  private readonly onEvent: ((name: string, detail?: unknown) => void) | undefined;
  private readonly afterBuildSnapshot:
    | ((ctx: { snapshotRoot: string; identity: InstallationIdentity }) => void)
    | undefined;

  constructor(opts: SandboxRunnerDeps) {
    // Parse trusted config with the canonical schema (Task 0 re-export).
    this.config = SandboxConfigSchema.parse(opts.config);
    if (!opts.snapshotStoreDir) {
      throw new Error(
        'SandboxRunner: snapshotStoreDir is REQUIRED and must be an explicit trusted path',
      );
    }
    this.snapshotStoreDir = opts.snapshotStoreDir;
    this.backends = opts.backends ?? [];
    this.proxyLauncher = opts.proxyLauncher ?? new DefaultProxyLauncher();
    this.secretProvider = opts.secretProvider ?? new MapSecretProvider(new Map());
    this.installationIdFor = opts.installationIdFor ?? lookupInstallationId;
    this.onEvent = opts.onEvent;
    this.afterBuildSnapshot = opts.afterBuildSnapshot;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  async run(input: SandboxRunInput): Promise<SandboxRunOutput> {
    const session = await this.prepareSession(input.skill);
    if (!session.ok) {
      return session.output;
    }
    const { backend, proxyHandle, sessionDir } = session;
    try {
      const env = buildGuestEnv({
        callerEnv: input.invocation?.env,
        payload: input.invocation?.payload,
        runtimeProfile: session.runtimeProfile,
      });
      const command = rewriteCommand(input.command, input.skill.dirPath);
      const spec: ExecSpec = {
        command,
        cwd: '/skill',
        env,
        stdin: input.invocation?.stdin,
        timeoutMs: input.timeoutMs,
      };
      const result = await backend.run(spec);
      return this.toRunOutput(result, backend);
    } catch (err) {
      return this.toErrorOutput(err, backend);
    } finally {
      await backend.cleanup().catch(() => {});
      await proxyHandle.close().catch(() => {});
      await removeSessionDir(sessionDir);
    }
  }

  async spawn(input: SandboxSpawnInput): Promise<SandboxSession> {
    const session = await this.prepareSession(input.skill);
    if (!session.ok) {
      throw new SandboxRunnerError(session.error.code, session.error.message);
    }
    const { backend, proxyHandle, sessionDir } = session;
    let process: SandboxProcess | undefined;
    try {
      const env = buildGuestEnv({
        callerEnv: input.invocation?.env,
        payload: input.invocation?.payload,
        runtimeProfile: session.runtimeProfile,
      });
      const command = rewriteCommand(input.command, input.skill.dirPath);
      const spec: SpawnSpec = {
        command,
        cwd: '/skill',
        env,
        timeoutMs: input.timeoutMs,
      };
      process = await backend.spawn(spec);
      const proc = process;
      return {
        process: proc,
        isolationLevel: backend.isolationLevel,
        backend: backend.kind,
        close: async () => {
          await proc.close().catch(() => {});
          await backend.cleanup().catch(() => {});
          await proxyHandle.close().catch(() => {});
          await removeSessionDir(sessionDir);
        },
      };
    } catch (err) {
      if (process) await process.close().catch(() => {});
      await backend.cleanup().catch(() => {});
      await proxyHandle.close().catch(() => {});
      await removeSessionDir(sessionDir);
      throw err;
    }
  }

  bind(skill: LoadedSkill): BoundSandboxExecutionPort {
    return {
      run: (input) => this.run({ ...input, skill }),
      spawn: (input) => this.spawn({ ...input, skill }),
    };
  }

  // -----------------------------------------------------------------------
  // Shared session preparation (ONE implementation for run + spawn)
  // -----------------------------------------------------------------------

  private async prepareSession(
    skill: LoadedSkill,
  ): Promise<PrepareSessionResult> {
    let backend: SandboxBackend | undefined;
    let proxyHandle: { close(): Promise<void> } | undefined;
    let sessionDir: string | undefined;
    try {
      // 1. installation identity (strict read)
      let installationId: string;
      try {
        installationId = this.installationIdFor(skill.dirPath);
      } catch (err) {
        throw new SandboxRunnerError(
          SANDBOX_ERROR.INSTALLATION_METADATA_MISSING,
          `installation id missing for ${skill.dirPath}: ${(err as Error).message}`,
        );
      }

      // 2. build snapshot
      this.onEvent?.('snapshot.build');
      const { identity, snapshotRoot } = await buildSnapshot({
        sourceDir: skill.dirPath,
        storeDir: this.snapshotStoreDir,
        installationId,
        name: skill.manifest.name,
      });
      this.afterBuildSnapshot?.({ snapshotRoot, identity });

      // 3. descriptor
      const descriptor = toSandboxDescriptor(skill, {
        snapshotRoot,
        digest: identity.digest,
        installationId,
      });

      // 4. resolve policy
      const policy = resolvePolicy(descriptor, this.config);

      // 5. resolve runtime profile (BEFORE any backend preparation)
      const runtimeProfile = resolveRuntimeProfile(this.config, descriptor);

      // 6. select backend (direct return; fail-closed)
      try {
        backend = await selectBackend(this.config, this.backends);
      } catch (err) {
        if (err instanceof NoFullBackendError) {
          throw new SandboxRunnerError(
            SANDBOX_ERROR.NO_SATISFYING_BACKEND,
            err.message,
          );
        }
        throw err;
      }

      // 7. prepare topology (creates carrier before proxy)
      const carrier = await backend.prepareTopology();

      // 8. provision secrets
      const secrets = await provisionSecrets(policy, identity, this.secretProvider);

      // 8b. unique PRIVATE per-session working directory. Concurrent sessions
      // MUST NOT share a workDir: the egress-proxy CA bundle is written
      // EXCLUSIVELY inside it (<sessionDir>/ca.pem, 0444) and a shared dir
      // would make concurrent sessions overwrite each other's CA. The session
      // root lives under the trusted snapshot store and is 0700; each leaf is
      // an mkdtemp dir (0700) removed in every exit path after proxy close.
      const sessionRoot = path.join(this.snapshotStoreDir, 'sessions');
      await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
      sessionDir = await mkdtemp(path.join(sessionRoot, 'oct-session-'));

      // 9. launch proxy
      const handle = await this.proxyLauncher.launch(
        { policy, secrets, workDir: sessionDir },
        carrier,
      );
      proxyHandle = handle;

      // 10. verify snapshot — LAST filesystem integrity op before prepare
      this.onEvent?.('snapshot.verify');
      const verified = await verifySnapshot(snapshotRoot, identity.digest);
      if (!verified) {
        throw new SandboxRunnerError(
          SANDBOX_ERROR.SNAPSHOT_MISMATCH,
          `snapshot digest mismatch for ${snapshotRoot}`,
        );
      }

      // 11. prepare backend
      const prepareOpts: BackendPrepareOptions = {
        ...policy,
        snapshotRoot,
        proxyAddr: handle.reachableAddr,
        caBundlePath: handle.caBundlePath,
        runtimeProfile,
        guestSkillRoot: '/skill',
        guestCaBundlePath: '/etc/skill-ca/ca.pem',
      };
      await backend.prepare(prepareOpts);

      return { ok: true, backend, proxyHandle: handle, runtimeProfile, sessionDir };
    } catch (err) {
      // Cleanup in reverse order on failure
      if (backend) await backend.cleanup().catch(() => {});
      if (proxyHandle) await proxyHandle.close().catch(() => {});
      if (sessionDir) await removeSessionDir(sessionDir);
      if (err instanceof SandboxRunnerError) {
        return {
          ok: false,
          output: this.toErrorOutput(err, backend),
          error: err,
        };
      }
      const runnerErr = new SandboxRunnerError(
        SANDBOX_ERROR.NO_SATISFYING_BACKEND,
        err instanceof Error ? err.message : String(err),
      );
      return {
        ok: false,
        output: this.toErrorOutput(runnerErr, backend),
        error: runnerErr,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Output helpers
  // -----------------------------------------------------------------------

  private toRunOutput(result: BackendRunResult, backend: SandboxBackend): SandboxRunOutput {
    return {
      success: result.exitCode === 0 && !result.timedOut,
      rawText: result.stdout,
      stderr: result.stderr,
      isolationLevel: backend.isolationLevel,
      backend: backend.kind,
    };
  }

  private toErrorOutput(err: unknown, backend: SandboxBackend | undefined): SandboxRunOutput {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: message,
      isolationLevel: backend?.isolationLevel ?? 'none',
      backend: backend?.kind ?? 'none',
    };
  }
}

// -----------------------------------------------------------------------
// Internal result type for prepareSession
// -----------------------------------------------------------------------

type PrepareSessionResult =
  | {
      ok: true;
      backend: SandboxBackend;
      proxyHandle: { close(): Promise<void> };
      runtimeProfile: ResolvedRuntimeProfile;
      /** Unique private 0700 mkdtemp dir; removed in every exit path. */
      sessionDir: string;
    }
  | { ok: false; output: SandboxRunOutput; error: SandboxRunnerError };
