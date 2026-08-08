/**
 * Default SandboxRunner construction (Plan 5 Task 4 + Task 10 VM wiring).
 *
 * Every Executor converges skill execution on a SandboxRunner. Production call
 * sites either inject one (tests) or let the Executor build the default here.
 * The default resolves the trusted `sandbox` config section and a stable
 * content-addressed snapshot store dir under the AgentOctopus config dir, then
 * constructs the canonical backends. Backend selection is fail-closed
 * (`selectBackend`): each backend probes its own privileges, and if none meets
 * `minIsolationLevel` the run fails with NO_SATISFYING_BACKEND — never a host
 * fallback.
 *
 * Sync `createDefaultSandboxRunner` builds Docker + OS + Windows (no
 * regression for existing callers / Executor constructor). Async
 * `createDefaultSandboxRunnerAsync` additionally tries the optional VM backend
 * via `createVmBackend` and includes it only when the native package is
 * present and complete.
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DockerBackend, OsSandboxBackend, WinSandboxBackend, type SandboxBackend, type SecretProvider } from '@agentoctopus/sandbox';
import { getConfig, getConfigDir } from './config-resolver.js';
import { SandboxRunner } from './sandbox-runner.js';
import {
  createVmBackend,
  type CreateVmBackendDeps,
} from './sandbox-vm-assembly.js';

/** Default content-addressed snapshot store dir (trusted, stable). */
export function defaultSnapshotStoreDir(): string {
  return path.join(getConfigDir(), 'sandbox-store');
}

/**
 * Build the default SandboxRunner from the resolved octopus.json config.
 * Backends are constructed fresh (a new sessionId per runner) so each runner
 * owns its topology; `probe()`/`selectBackend` decide which is actually used.
 *
 * Sync form: Docker + OS only. Prefer `createDefaultSandboxRunnerAsync` when
 * the optional VM native package should be considered.
 *
 * An optional `secretProvider` may be injected (built once at the composition
 * root via buildSecretProviderFromConfig). When omitted, the runner defaults to
 * an EMPTY provider — no secrets are provisioned. This keeps the no-arg form
 * working for call sites that cannot reach the LLM-guided credential paths
 * (web singleton, multi-agent instances).
 */
export function createDefaultSandboxRunner(secretProvider?: SecretProvider, options?: { telemetrySink?: import('./execution-context.js').TelemetrySink }): SandboxRunner {
  const config = getConfig().sandbox;
  const sessionId = randomUUID().slice(0, 8);
  const backends: SandboxBackend[] = [
    new DockerBackend({ config, sessionId }),
    new OsSandboxBackend({ sessionId }),
    new WinSandboxBackend({ sessionId }),
  ];
  return new SandboxRunner({
    config,
    snapshotStoreDir: defaultSnapshotStoreDir(),
    backends,
    ...(secretProvider ? { secretProvider } : {}),
    ...(options?.telemetrySink ? { telemetrySink: options.telemetrySink } : {}),
  });
}

export type CreateDefaultSandboxRunnerAsyncDeps = {
  /** Test-only seam; production omits and uses the real createVmBackend. */
  createVmBackend?: typeof createVmBackend;
  loadNative?: CreateVmBackendDeps['loadNative'];
};

/**
 * Async default runner: Docker + OS + VM-if-available.
 *
 * VM is included only when `createVmBackend` returns a real backend. Missing
 * or incomplete native package fails closed (VM simply omitted from the list;
 * selection still fail-closes if no backend meets minIsolationLevel).
 */
export async function createDefaultSandboxRunnerAsync(
  secretProvider?: SecretProvider,
  deps?: CreateDefaultSandboxRunnerAsyncDeps,
): Promise<SandboxRunner> {
  const config = getConfig().sandbox;
  const sessionId = randomUUID().slice(0, 8);
  const backends: SandboxBackend[] = [
    new DockerBackend({ config, sessionId }),
    new OsSandboxBackend({ sessionId }),
    new WinSandboxBackend({ sessionId }),
  ];

  const assemble = deps?.createVmBackend ?? createVmBackend;
  const vm = await assemble(
    config,
    deps?.loadNative ? { loadNative: deps.loadNative } : undefined,
  );
  if (!('unavailable' in vm)) {
    backends.push(vm);
  }

  return new SandboxRunner({
    config,
    snapshotStoreDir: defaultSnapshotStoreDir(),
    backends,
    ...(secretProvider ? { secretProvider } : {}),
  });
}
