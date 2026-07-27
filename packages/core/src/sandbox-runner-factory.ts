/**
 * Default SandboxRunner construction (Plan 5 Task 4).
 *
 * Every Executor converges skill execution on a SandboxRunner. Production call
 * sites either inject one (tests) or let the Executor build the default here.
 * The default resolves the trusted `sandbox` config section and a stable
 * content-addressed snapshot store dir under the AgentOctopus config dir, then
 * constructs the canonical backends. Backend selection is fail-closed
 * (`selectBackend`): each backend probes its own privileges, and if none meets
 * `minIsolationLevel` the run fails with NO_SATISFYING_BACKEND — never a host
 * fallback.
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DockerBackend, OsSandboxBackend, type SandboxBackend, type SecretProvider } from '@agentoctopus/sandbox';
import { getConfig, getConfigDir } from './config-resolver.js';
import { SandboxRunner } from './sandbox-runner.js';

/** Default content-addressed snapshot store dir (trusted, stable). */
export function defaultSnapshotStoreDir(): string {
  return path.join(getConfigDir(), 'sandbox-store');
}

/**
 * Build the default SandboxRunner from the resolved octopus.json config.
 * Backends are constructed fresh (a new sessionId per runner) so each runner
 * owns its topology; `probe()`/`selectBackend` decide which is actually used.
 *
 * An optional `secretProvider` may be injected (built once at the composition
 * root via buildSecretProviderFromConfig). When omitted, the runner defaults to
 * an EMPTY provider — no secrets are provisioned. This keeps the no-arg form
 * working for call sites that cannot reach the LLM-guided credential paths
 * (web singleton, multi-agent instances).
 */
export function createDefaultSandboxRunner(secretProvider?: SecretProvider): SandboxRunner {
  const config = getConfig().sandbox;
  const sessionId = randomUUID().slice(0, 8);
  const backends: SandboxBackend[] = [
    new DockerBackend({ config, sessionId }),
    new OsSandboxBackend({ sessionId }),
  ];
  return new SandboxRunner({
    config,
    snapshotStoreDir: defaultSnapshotStoreDir(),
    backends,
    ...(secretProvider ? { secretProvider } : {}),
  });
}
