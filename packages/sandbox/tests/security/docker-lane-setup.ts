/**
 * Shared Docker-lane orchestration for the Plan 6 Task 2 security tests.
 *
 * Implements the canonical orchestration order against the REAL Docker backend
 * and the REAL production proxy image (no fakes, no SessionCa.create here —
 * the launcher alone owns the CA):
 *
 *   buildSnapshot (immutable, content-addressed)
 *     → resolvePolicy / ResolvedSecrets
 *     → SandboxConfigSchema.parse (digest-pinned runtime + proxy images)
 *     → new DockerBackend → selectBackend
 *     → backend.prepareTopology()        (internal + egress networks)
 *     → DefaultProxyLauncher.launch({policy, secrets, workDir}, carrier)
 *     → verifySnapshot (LAST fs op)
 *     → backend.prepare({snapshotRoot, proxyAddr, caBundlePath, runtimeProfile,
 *                        guestSkillRoot:'/skill', guestCaBundlePath:'/etc/skill-ca/ca.pem'})
 *
 * Leaf-package rule: imports only Node stdlib + this package's own src + the
 * Task 1 harness. NEVER imports from @agentoctopus/{core,registry,adapters,skills}.
 */

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { SandboxConfigSchema, type SandboxConfig } from '../../src/schema.js';
import { buildSnapshot, verifySnapshot, type BuiltSnapshot } from '../../src/snapshot.js';
import { resolvePolicy, type SandboxPolicy } from '../../src/policy.js';
import { selectBackend, type SandboxBackend, type ResolvedRuntimeProfile } from '../../src/backend.js';
import { DockerBackend } from '../../src/docker/docker-backend.js';
import { DefaultProxyLauncher, type ProxyHandle } from '../../src/proxy/launcher.js';
import type { ResolvedSecrets } from '../../src/proxy/egress-proxy.js';
import type { SandboxSkillDescriptor, SandboxRequest } from '../../src/types.js';
import { requirePinnedImageRef, makeProbeSkill } from './harness.js';
import { LANE_PROBE_SCRIPT, LANE_PROBE_REL, HTTP_PROBE_SCRIPT, HTTP_PROBE_REL, FETCH_PROBE_SCRIPT, FETCH_PROBE_REL } from './lane-probe.js';

/** Default per-probe resource caps (tight, so caps/timeout tests stay fast). */
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_OUTPUT_MAX_BYTES = 32_768;

export interface DockerSandboxOptions {
  /**
   * Hosts the skill requests. Combined with the granted hosts via policy
   * resolution (requested ∩ granted). For adversarial cases both stay empty
   * (deny-all). For the topology egress case, request + grant the upstream.
   */
  request?: SandboxRequest;
  /** Extra InstallationGrant hosts added to config.grants for this snapshot. */
  grantedHosts?: string[];
  /**
   * Hook invoked AFTER prepareTopology() (so both networks exist) but BEFORE
   * the policy is resolved and the proxy launched. It receives the carrier and
   * may start an egress-reachable upstream, returning the additional hosts to
   * grant (e.g. the upstream's exact egress-network IP literal). This lets the
   * topology lane grant a target whose IP only exists once the egress network
   * is up, while still baking the grant into the proxy's policy at launch.
   */
  afterTopology?: (carrier: { internalNetwork: string; egressNetwork: string }) => Promise<string[]>;
  /** Per-probe overrides folded into the run spec (timeout, output cap). */
  timeoutMs?: number;
  outputMaxBytes?: number;
}

export interface DockerSandbox {
  backend: SandboxBackend;
  proxy: ProxyHandle;
  snapshot: BuiltSnapshot;
  policy: SandboxPolicy;
  config: SandboxConfig;
  workDir: string;
  /** The runtime container name the backend will use (for docker top/inspect/ps). */
  runtimeContainerName: string;
  /** The internal and egress network names from the carrier. */
  internalNetwork: string;
  egressNetwork: string;
  /** Idempotent full teardown: proxy.close() (owns CA) → backend.cleanup() → rm tmp. */
  cleanup(): Promise<void>;
}

function runtimeImageRef(): string {
  return requirePinnedImageRef('runtime', process.env.OCTOPUS_TEST_RUNTIME_IMAGE!);
}

function proxyImageRef(): string {
  return requirePinnedImageRef('proxy', process.env.OCTOPUS_TEST_PROXY_IMAGE!);
}

/**
 * Build a real immutable snapshot of the probe skill, resolve policy/runtime
 * profile/secrets, select the Docker backend, prepare its topology, launch the
 * production proxy image, verify the snapshot, and prepare the backend with the
 * exact canonical options. Returns a handle owning full teardown.
 */
export async function setupDockerSandbox(opts: DockerSandboxOptions = {}): Promise<DockerSandbox> {
  const sessionId = randomUUID().slice(0, 8);
  const workDir = await mkdtemp(join(tmpdir(), 'octopus-dlane-'));

  // Materialize the probe skill: the Task 1 harness probe (scripts/probe.js)
  // plus the lane JSON probe (probe.js) this lane drives for result.json.*.
  const skillSrc = await mkdtemp(join(tmpdir(), 'octopus-dlane-skill-'));
  await makeProbeSkill(skillSrc);
  await writeFile(join(skillSrc, LANE_PROBE_REL), LANE_PROBE_SCRIPT, 'utf8');
  await writeFile(join(skillSrc, HTTP_PROBE_REL), HTTP_PROBE_SCRIPT, 'utf8');
  await writeFile(join(skillSrc, FETCH_PROBE_REL), FETCH_PROBE_SCRIPT, 'utf8');

  const snapshot = await buildSnapshot({
    sourceDir: skillSrc,
    storeDir: join(workDir, 'store'),
    installationId: `docker-lane-${sessionId}`,
    name: 'docker-lane-probe',
  });

  // Base config drives backend construction + topology; grants are resolved
  // into the policy AFTER prepareTopology so an afterTopology hook can name an
  // egress-reachable upstream whose IP only exists once the egress network is up.
  const baseConfig = SandboxConfigSchema.parse({
    docker: { image: runtimeImageRef() },
    proxy: { artifact: proxyImageRef() },
    defaults: { timeoutMs: DEFAULT_TIMEOUT_MS, outputMaxBytes: DEFAULT_OUTPUT_MAX_BYTES },
  });

  const descriptor: SandboxSkillDescriptor = {
    identity: snapshot.identity,
    snapshotRoot: snapshot.snapshotRoot,
    request: opts.request ?? {},
  };
  const secrets: ResolvedSecrets = {};
  const runtimeProfile: ResolvedRuntimeProfile = {
    id: 'docker-lane',
    bins: ['node'],
    path: '/usr/local/bin',
    dockerImage: runtimeImageRef(),
  };

  const backend = new DockerBackend({ config: baseConfig, sessionId });
  const selected = await selectBackend(baseConfig, [backend]);

  let cleaned = false;
  let proxy: ProxyHandle | undefined;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    // Reverse order, idempotent: proxy close owns the launcher-created CA.
    if (proxy) await proxy.close().catch(() => {});
    await selected.cleanup().catch(() => {});
    await rm(skillSrc, { recursive: true, force: true }).catch(() => {});
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  };

  let carrier;
  try {
    carrier = await selected.prepareTopology();
  } catch (err) {
    await cleanup();
    throw err;
  }
  if (carrier.kind !== 'docker-sidecar') {
    await cleanup();
    throw new Error(`expected a docker-sidecar carrier, got ${carrier.kind}`);
  }

  // Networks now exist. Let the hook start an egress-reachable upstream and
  // return the extra hosts to grant before the proxy's policy is fixed. The
  // hook hosts are both REQUESTED and GRANTED so requested ∩ granted keeps them.
  const hookHosts = opts.afterTopology
    ? await opts.afterTopology({ internalNetwork: carrier.internalNetwork, egressNetwork: carrier.egressNetwork })
    : [];
  const grantedHosts = [...(opts.grantedHosts ?? []), ...hookHosts];

  const config = SandboxConfigSchema.parse({
    docker: { image: runtimeImageRef() },
    proxy: { artifact: proxyImageRef() },
    defaults: { timeoutMs: DEFAULT_TIMEOUT_MS, outputMaxBytes: DEFAULT_OUTPUT_MAX_BYTES },
    grants: grantedHosts.length > 0
      ? [{ installationId: snapshot.identity.installationId, digest: snapshot.identity.digest, hosts: grantedHosts }]
      : [],
  });
  const requestDescriptor: SandboxSkillDescriptor = {
    ...descriptor,
    request: { ...descriptor.request, hosts: [...(descriptor.request.hosts ?? []), ...hookHosts] },
  };
  const policy = resolvePolicy(requestDescriptor, config);

  try {
    proxy = await new DefaultProxyLauncher().launch({ policy, secrets, workDir }, carrier);

    // verifySnapshot is the LAST filesystem op before prepare().
    const verified = await verifySnapshot(snapshot.snapshotRoot, snapshot.identity.digest);
    if (!verified) throw new Error('snapshot verification failed');

    await selected.prepare({
      ...policy,
      snapshotRoot: snapshot.snapshotRoot,
      expectedSnapshotDigest: snapshot.identity.digest,
      proxyAddr: proxy.reachableAddr,
      caBundlePath: proxy.caBundlePath,
      runtimeProfile,
      guestSkillRoot: '/skill',
      guestCaBundlePath: '/etc/skill-ca/ca.pem',
    });
  } catch (err) {
    await cleanup();
    throw err;
  }

  return {
    backend: selected,
    proxy,
    snapshot,
    policy,
    config,
    workDir,
    runtimeContainerName: `octopus-sbx-runtime-${sessionId}`,
    internalNetwork: carrier.internalNetwork,
    egressNetwork: carrier.egressNetwork,
    cleanup,
  };
}

export interface ProbeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Parsed from the single JSON object the lane probe emits on stdout. */
  json: Record<string, unknown>;
}

export interface RunProbeOptions {
  /** Extra env injected into the probe (e.g. HOST_CANARY_PATH). */
  env?: Record<string, string>;
  /** Override the exact command argv (defaults to node /skill/probe.js). */
  command?: string[];
  timeoutMs?: number;
  outputMaxBytes?: number;
  /** Sandbox/policy options forwarded to setupDockerSandbox. */
  sandbox?: DockerSandboxOptions;
}

/**
 * Run one lane probe action through the full Docker sandbox and parse the
 * single JSON object the probe emits on stdout. Tears the sandbox down fully.
 */
export async function runProbe(action: string, options: RunProbeOptions = {}): Promise<ProbeResult> {
  const sandbox = await setupDockerSandbox(options.sandbox ?? {});
  try {
    const command = options.command ?? ['node', '/skill/probe.js'];
    const result = await sandbox.backend.run({
      command,
      env: { PROBE_ACTION: action, ...(options.env ?? {}) },
      timeoutMs: options.timeoutMs,
      outputMaxBytes: options.outputMaxBytes,
    });
    return { ...result, json: parseProbeJson(result.stdout) };
  } finally {
    await sandbox.cleanup();
  }
}

/** Extract the first complete JSON object line from probe stdout. */
function parseProbeJson(stdout: string): Record<string, unknown> {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // partial line (output cap may have cut it) — keep scanning
    }
  }
  return {};
}
