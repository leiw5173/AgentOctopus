/**
 * Shared VM-lane orchestration for the L3 integration tests (Task 18).
 *
 * Mirrors docker-lane-setup.ts but against the REAL libkrun VM backend via
 * `createVmBackend` (Task 10's assembly factory, which dynamically imports
 * @agentoctopus/sandbox-vm-native). The VM lane boots a real guest: rootfs
 * (vda, read-only ext4) + skill block image (vdb) + CA block image (vdc),
 * with the sandbox-vm-helper (Task 11) driving the pinned TSI-disabled
 * krun start sequence and vm-init (Task 12) as PID 1.
 *
 * Skip policy: the lane runs ONLY when BOTH:
 *   - OCTOPUS_VM_LANE === '1' (operator opts into the real-VM lane), AND
 *   - backend.probe() returns true (libkrun + rootfs + helper all present
 *     and TCB-verified on this host).
 * Otherwise every test skips — the L3 lane is CI-owned (macOS Apple Silicon
 * runner with the vendored libs + produced rootfs). Local runs skip.
 *
 * Leaf-package rule: imports only Node stdlib + this package's own src +
 * the Task 1 harness + core's createVmBackend. NEVER imports from
 * @agentoctopus/{registry,adapters,skills} directly.
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { SandboxConfigSchema, type SandboxConfig } from '../../src/schema.js';
import { buildSnapshot, verifySnapshot, type BuiltSnapshot } from '../../src/snapshot.js';
import { resolvePolicy, type SandboxPolicy } from '../../src/policy.js';
import { selectBackend, type SandboxBackend, type ResolvedRuntimeProfile } from '../../src/backend.js';
import { DefaultProxyLauncher, type ProxyHandle } from '../../src/proxy/launcher.js';
import type { ResolvedSecrets } from '../../src/proxy/egress-proxy.js';
import type { SandboxSkillDescriptor, SandboxRequest } from '../../src/types.js';
import { VmSandboxBackend } from '../../src/vm/vm-backend.js';
import { makeProbeSkill } from './harness.js';
import { LANE_PROBE_SCRIPT, LANE_PROBE_REL, HTTP_PROBE_SCRIPT, HTTP_PROBE_REL } from './lane-probe.js';

// createVmBackend lives in core, but core depends on sandbox (circular if
// sandbox imports core). The leaf package must NOT import core. Instead we
// dynamically import @agentoctopus/sandbox-vm-native directly — the same
// pattern createVmBackend uses internally (Task 10's assembly factory).
// Missing/incomplete native fails closed to a thrown Error (caller skipIf's
// on vmLaneEnabled() + probe() before reaching here).

/** Default per-probe resource caps (tight, so caps/timeout tests stay fast). */
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_OUTPUT_MAX_BYTES = 32_768;

export interface VmSandboxOptions {
  request?: SandboxRequest;
  grantedHosts?: string[];
  timeoutMs?: number;
  outputMaxBytes?: number;
}

export interface VmSandbox {
  backend: SandboxBackend;
  proxy: ProxyHandle;
  snapshot: BuiltSnapshot;
  policy: SandboxPolicy;
  config: SandboxConfig;
  workDir: string;
  /** Idempotent full teardown: proxy.close() → backend.cleanup() → rm tmp. */
  cleanup(): Promise<void>;
}

/**
 * The VM lane is opt-in. Returns true only when the operator explicitly
 * requests it (OCTOPUS_VM_LANE=1). The per-test skipIf ALSO checks
 * backend.probe() — this gate just controls whether we even attempt to
 * build the native backend.
 */
export function vmLaneEnabled(): boolean {
  return process.env.OCTOPUS_VM_LANE === '1';
}

/**
 * Build a real immutable snapshot of the probe skill, assemble the VM backend
 * via createVmBackend, launch the proxy, verify the snapshot, and prepare the
 * backend. Returns a handle owning full teardown.
 *
 * Throws if the native package is unavailable (caller should skipIf on
 * vmLaneEnabled() + probe() before reaching here).
 */
export async function setupVmSandbox(opts: VmSandboxOptions = {}): Promise<VmSandbox> {
  const sessionId = randomUUID().slice(0, 8);
  const workDir = await mkdtemp(join(tmpdir(), 'octopus-vmlane-'));

  const skillSrc = await mkdtemp(join(tmpdir(), 'octopus-vmlane-skill-'));
  await makeProbeSkill(skillSrc);
  await writeFile(join(skillSrc, LANE_PROBE_REL), LANE_PROBE_SCRIPT, 'utf8');
  await writeFile(join(skillSrc, HTTP_PROBE_REL), HTTP_PROBE_SCRIPT, 'utf8');

  const snapshot = await buildSnapshot({
    sourceDir: skillSrc,
    storeDir: join(workDir, 'store'),
    installationId: `vm-lane-${sessionId}`,
    name: 'vm-lane-probe',
  });

  // VM config: the rootfs + mem/cpus live on the per-profile vmRuntime.
  // The rootfs ref is the produced prebuilds/<platform>/rootfs.img byte
  // digest (Task 15). On a qualified lane, the gate manifest lists it in
  // qualifiedRootfsDigests[].
  const baseConfig = SandboxConfigSchema.parse({
    defaultBackend: 'vm',
    minIsolationLevel: 'full',
    defaults: { timeoutMs: DEFAULT_TIMEOUT_MS, outputMaxBytes: DEFAULT_OUTPUT_MAX_BYTES },
  });

  const descriptor: SandboxSkillDescriptor = {
    identity: snapshot.identity,
    snapshotRoot: snapshot.snapshotRoot,
    request: opts.request ?? {},
  };
  const secrets: ResolvedSecrets = {};
  const runtimeProfile: ResolvedRuntimeProfile = {
    id: 'vm-lane',
    bins: ['node'],
    path: '/usr/bin',
    vmRuntime: {
      // rootfs ref + guest geometry. On a real lane these come from the
      // produced rootfs.manifest.json; tests read them via env so the lane
      // is parameterized by the CI-produced artifact.
      rootfs: process.env.OCTOPUS_VM_ROOTFS_REF ?? ('sha256:' + '0'.repeat(64)),
      memMib: 512,
      cpus: 1,
      executables: { node: '/usr/bin/node' },
    },
  } as ResolvedRuntimeProfile;

  // Assemble the real native VM backend by dynamically importing
  // @agentoctopus/sandbox-vm-native (same pattern as createVmBackend in
  // core, but inlined here so the leaf sandbox package does not import core
  // — that would be a circular dependency). Missing/incomplete native fails
  // closed to a thrown Error.
  let native: any;
  try {
    native = await import('@agentoctopus/sandbox-vm-native');
  } catch {
    await rm(skillSrc, { recursive: true, force: true }).catch(() => {});
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw new Error('VM backend unavailable: native package missing');
  }
  if (typeof native.VmEngineImpl !== 'function' || typeof native.VmImageBuilderImpl !== 'function') {
    await rm(skillSrc, { recursive: true, force: true }).catch(() => {});
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw new Error('VM backend unavailable: native package incomplete');
  }
  const engine = new native.VmEngineImpl();
  const imageBuilder = new native.VmImageBuilderImpl();
  const backend = new VmSandboxBackend({ config: baseConfig, engine, imageBuilder });

  const selected = await selectBackend(baseConfig, [backend]);

  let cleaned = false;
  let proxy: ProxyHandle | undefined;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    if (proxy) await proxy.close().catch(() => {});
    await selected.cleanup().catch(() => {});
    await rm(skillSrc, { recursive: true, force: true }).catch(() => {});
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  };

  // VM backend has no topology to prepare (in-process carrier), but call it
  // for parity with the Docker lane's orchestration order.
  let carrier;
  try {
    carrier = await selected.prepareTopology();
  } catch (err) {
    await cleanup();
    throw err;
  }
  if (carrier.kind !== 'in-process') {
    await cleanup();
    throw new Error(`expected in-process carrier for VM backend, got ${carrier.kind}`);
  }

  const grantedHosts = opts.grantedHosts ?? [];
  const config = SandboxConfigSchema.parse({
    ...baseConfig,
    grants: grantedHosts.length > 0
      ? [{ installationId: snapshot.identity.installationId, digest: snapshot.identity.digest, hosts: grantedHosts }]
      : [],
  });
  const requestDescriptor: SandboxSkillDescriptor = {
    ...descriptor,
    request: { ...descriptor.request, hosts: [...(descriptor.request.hosts ?? []), ...grantedHosts] },
  };
  const policy = resolvePolicy(requestDescriptor, config);

  try {
    proxy = await new DefaultProxyLauncher().launch({ policy, secrets, workDir }, carrier);

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
    cleanup,
  };
}

export interface ProbeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  json: Record<string, unknown>;
}

export interface RunProbeOptions {
  env?: Record<string, string>;
  command?: string[];
  timeoutMs?: number;
  outputMaxBytes?: number;
  sandbox?: VmSandboxOptions;
}

/** Run one lane probe action through the full VM sandbox. Tears it down. */
export async function runProbe(action: string, options: RunProbeOptions = {}): Promise<ProbeResult> {
  const sandbox = await setupVmSandbox(options.sandbox ?? {});
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
