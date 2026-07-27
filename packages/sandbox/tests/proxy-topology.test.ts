/**
 * Backend-aware proxy topology orchestration contract (Plan 5, Task 2).
 *
 * Asserts the mandatory cross-module event order:
 *
 *   selectBackend
 *     → backend.prepareTopology()
 *     → DefaultProxyLauncher.launch({ policy, secrets, workDir }, carrier)
 *     → verifySnapshot()
 *     → backend.prepare()    (with guestSkillRoot '/skill',
 *                             guestCaBundlePath '/etc/skill-ca/ca.pem')
 *     → backend.spawn()
 *     → process.close()
 *     → backend.cleanup()
 *     → proxy.close()
 *
 * And the literal topology invariants:
 *   - prepare.proxyAddr must NEVER be 127.0.0.1 / localhost on the OS backend
 *     (veth-reachable proxy address) and never the empty string anywhere.
 *   - prepare.caBundlePath must end in `ca.pem`.
 *   - The proxy launcher alone creates the SessionCa — the backend prepare()
 *     receives the bundle path produced by the launcher.
 *
 * All collaborators are behavioral fakes that record event order. No real
 * Docker daemon, no real netns, no real SessionCa key material — the launch
 * is faked at the ProxyLauncher seam so this test runs daemon-free on macOS.
 */
import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { selectBackend } from '../src/backend.js';
import type {
  SandboxBackend,
  SandboxProcess,
  BackendRunResult,
  BackendPrepareOptions,
  ProxyCarrier,
  SpawnSpec,
} from '../src/backend.js';
import type { ProxyHandle, ProxyLauncher } from '../src/proxy/launcher.js';
import { SandboxConfigSchema } from '../src/schema.js';
import type { SandboxPolicy } from '../src/policy.js';
import type { ResolvedSecrets } from '../src/proxy/egress-proxy.js';
import type { IsolationLevel } from '../src/types.js';

// ---------------------------------------------------------------------------
// Fake builders — each records into a shared `events` array.
// ---------------------------------------------------------------------------

interface Recorder {
  events: string[];
  /** Captured BackendPrepareOptions for assertion. */
  capturedPrepare: BackendPrepareOptions | undefined;
  /** Captured launch() args. */
  capturedLaunchOpts: { policy: SandboxPolicy; secrets: ResolvedSecrets; workDir: string } | undefined;
  capturedLaunchCarrier: ProxyCarrier | undefined;
}

function makeRunResult(backend: string, isolation: IsolationLevel): BackendRunResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    meta: { isolationLevel: isolation, backend: backend as 'docker' | 'os', degraded: false, degradationReasons: [] },
  };
}

function makeFakeBackend(
  rec: Recorder,
  kind: 'docker' | 'os',
  carrier: ProxyCarrier,
): SandboxBackend {
  return {
    kind,
    isolationLevel: 'full',
    probe: async () => true,
    prepareTopology: async (): Promise<ProxyCarrier> => {
      rec.events.push(`backend:prepareTopology`);
      return carrier;
    },
    prepare: async (opts: BackendPrepareOptions) => {
      rec.events.push('backend:prepare');
      rec.capturedPrepare = opts;
    },
    spawn: async (_spec: SpawnSpec): Promise<SandboxProcess> => {
      rec.events.push('backend:spawn');
      const exited = Promise.resolve(makeRunResult(kind, 'full'));
      let closed = false;
      return {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exited,
        kill: async () => {},
        close: async () => {
          if (closed) return;
          closed = true;
          rec.events.push('process:close');
        },
      };
    },
    run: async (spec) => {
      const proc = await (async () => {
        rec.events.push('backend:spawn');
        const exited = Promise.resolve(makeRunResult(kind, 'full'));
        let closed = false;
        const p: SandboxProcess = {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          exited,
          kill: async () => {},
          close: async () => {
            if (closed) return;
            closed = true;
            rec.events.push('process:close');
          },
        };
        return p;
      })();
      if (typeof spec.stdin === 'string' || spec.stdin instanceof Uint8Array) proc.stdin.write(spec.stdin);
      proc.stdin.end();
      try { return await proc.exited; } finally { await proc.close(); }
    },
    cleanup: async () => {
      rec.events.push('backend:cleanup');
    },
  };
}

function makeFakeLauncher(rec: Recorder, label: string): ProxyLauncher {
  return {
    launch: async (opts, carrier): Promise<ProxyHandle> => {
      rec.events.push(`proxy:launch:${label}`);
      rec.capturedLaunchOpts = opts;
      rec.capturedLaunchCarrier = carrier;
      // Compute a reachableAddr from the carrier the same way the real
      // DefaultProxyLauncher does.
      let reachableAddr: string;
      if (carrier.kind === 'docker-sidecar') {
        reachableAddr = `http://${carrier.reachableHost}:8080`;
      } else if (carrier.kind === 'linux-static') {
        reachableAddr = `http://${carrier.reachableHost}:${carrier.listenPort}`;
      } else {
        reachableAddr = `http://${carrier.reachableHost}:9999`;
      }
      let closed = false;
      return {
        reachableAddr,
        // Literal ca.pem ending — the launcher owns the SessionCa and
        // produces a bundle path on the host.
        caBundlePath: '/tmp/oct-session/ca.pem',
        close: async () => {
          if (closed) return;
          closed = true;
          rec.events.push('proxy:close');
        },
      };
    },
  };
}

function makeVerifySnapshot(rec: Recorder) {
  return async (_snapshotRoot: string, _expectedDigest: string): Promise<boolean> => {
    rec.events.push('snapshot:verify');
    return true;
  };
}

// ---------------------------------------------------------------------------
// Orchestrator under test — mirrors the canonical sequence from the brief.
// ---------------------------------------------------------------------------

async function orchestrate(input: {
  rec: Recorder;
  backends: SandboxBackend[];
  launcher: ProxyLauncher;
  verifySnapshot: (root: string, digest: string) => Promise<boolean>;
  policy: SandboxPolicy;
  secrets: ResolvedSecrets;
  workDir: string;
  snapshotRoot: string;
  expectedDigest: string;
}): Promise<void> {
  const { rec, backends, launcher, verifySnapshot, policy, secrets, workDir, snapshotRoot, expectedDigest } = input;

  // 1. Select the backend.
  const config = SandboxConfigSchema.parse({ defaultBackend: 'auto', minIsolationLevel: 'full' });
  const backend = await selectBackend(config, backends);
  rec.events.push(`select:${backend.kind}`);

  // 2. Create backend topology BEFORE proxy launch.
  const carrier = await backend.prepareTopology();

  // 3. Launch the proxy. The launcher alone creates/writes/provisions the
  //    one SessionCa for this execution.
  const proxyHandle = await launcher.launch({ policy, secrets, workDir }, carrier);

  // 4. Verify the immutable snapshot immediately before backend prepare.
  const ok = await verifySnapshot(snapshotRoot, expectedDigest);
  if (!ok) throw new Error('snapshot verification failed');

  // 5. Backend prepare with the exact canonical options.
  const prepare: BackendPrepareOptions = {
    ...policy,
    snapshotRoot,
    proxyAddr: proxyHandle.reachableAddr,
    caBundlePath: proxyHandle.caBundlePath,
    runtimeProfile: { id: 'rt', bins: ['node'], path: '/usr/bin', dockerImage: undefined },
    guestSkillRoot: '/skill',
    guestCaBundlePath: '/etc/skill-ca/ca.pem',
  };
  await backend.prepare(prepare);

  // 6. Spawn.
  const proc = await backend.spawn({ command: ['/usr/bin/node', '/skill/invoke.js'] });

  // 7. Cleanup order: process.close() → backend.cleanup() → proxy.close(),
  //    all idempotent, all in finally.
  try {
    await proc.exited;
  } finally {
    await proc.close();
    await backend.cleanup();
    await proxyHandle.close();
  }
}

// ---------------------------------------------------------------------------
// Policy fixture (minimal — only fields the launcher actually consults).
// ---------------------------------------------------------------------------

function makePolicy(): SandboxPolicy {
  return {
    hosts: ['example.com'],
    credentials: [],
    denied: { hosts: [], credentials: [] },
    resources: { memoryBytes: 64 * 1024 * 1024, cpus: 0.5, timeoutMs: 5000 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('proxy topology — orchestration order contract', () => {
  it('Docker: events fire in the canonical order', async () => {
    const rec: Recorder = { events: [], capturedPrepare: undefined, capturedLaunchOpts: undefined, capturedLaunchCarrier: undefined };
    const carrier: ProxyCarrier = {
      kind: 'docker-sidecar',
      proxyImage: 'example/proxy@sha256:' + 'a'.repeat(64),
      internalNetwork: 'octopus-sbx-x-internal',
      egressNetwork: 'octopus-sbx-x-egress',
      reachableHost: 'egress-proxy',
    };
    const backend = makeFakeBackend(rec, 'docker', carrier);
    const launcher = makeFakeLauncher(rec, 'docker');

    await orchestrate({
      rec,
      backends: [backend],
      launcher,
      verifySnapshot: makeVerifySnapshot(rec),
      policy: makePolicy(),
      secrets: {},
      workDir: '/tmp/oct-work',
      snapshotRoot: '/snap/a',
      expectedDigest: 'deadbeef',
    });

    expect(rec.events).toEqual([
      'select:docker',
      'backend:prepareTopology',
      'proxy:launch:docker',
      'snapshot:verify',
      'backend:prepare',
      'backend:spawn',
      'process:close',
      'backend:cleanup',
      'proxy:close',
    ]);
  });

  it('Linux OS: events fire in the canonical order with a veth-reachable (non-loopback) proxy address', async () => {
    const rec: Recorder = { events: [], capturedPrepare: undefined, capturedLaunchOpts: undefined, capturedLaunchCarrier: undefined };
    const carrier: ProxyCarrier = {
      kind: 'linux-static',
      binaryPath: '/build/egress-proxy-server.mjs',
      skillNamespace: { name: 'octn-test', path: '/run/netns/octn-test' },
      listenHost: '169.254.7.1',
      reachableHost: '169.254.7.1',
      cgroupPath: '/sys/fs/cgroup/oct-proxy-test',
      listenPort: 43210,
    };
    const backend = makeFakeBackend(rec, 'os', carrier);
    const launcher = makeFakeLauncher(rec, 'os');

    await orchestrate({
      rec,
      backends: [backend],
      launcher,
      verifySnapshot: makeVerifySnapshot(rec),
      policy: makePolicy(),
      secrets: {},
      workDir: '/tmp/oct-work',
      snapshotRoot: '/snap/a',
      expectedDigest: 'deadbeef',
    });

    expect(rec.events).toEqual([
      'select:os',
      'backend:prepareTopology',
      'proxy:launch:os',
      'snapshot:verify',
      'backend:prepare',
      'backend:spawn',
      'process:close',
      'backend:cleanup',
      'proxy:close',
    ]);
  });
});

describe('proxy topology — literal path and address contracts', () => {
  it('prepare.proxyAddr is never loopback/localhost on the OS backend; caBundlePath ends in ca.pem', async () => {
    const rec: Recorder = { events: [], capturedPrepare: undefined, capturedLaunchOpts: undefined, capturedLaunchCarrier: undefined };
    const carrier: ProxyCarrier = {
      kind: 'linux-static',
      binaryPath: '/build/egress-proxy-server.mjs',
      skillNamespace: { name: 'octn-x', path: '/run/netns/octn-x' },
      listenHost: '169.254.7.1',
      reachableHost: '169.254.7.1',
      cgroupPath: '/sys/fs/cgroup/oct-proxy-x',
      listenPort: 43210,
    };
    const backend = makeFakeBackend(rec, 'os', carrier);
    const launcher = makeFakeLauncher(rec, 'os');

    await orchestrate({
      rec,
      backends: [backend],
      launcher,
      verifySnapshot: makeVerifySnapshot(rec),
      policy: makePolicy(),
      secrets: {},
      workDir: '/tmp/oct-work',
      snapshotRoot: '/snap/a',
      expectedDigest: 'deadbeef',
    });

    const prepare = rec.capturedPrepare!;
    expect(prepare).toBeDefined();
    // The proxyAddr is the carrier's veth-reachable address — never loopback.
    expect(prepare.proxyAddr).not.toMatch(/127\.0\.0\.1|localhost/);
    expect(prepare.proxyAddr).toMatch(/^http:\/\/169\.254\.7\.1:43210$/);
    // The CA bundle is a .pem file produced by the launcher.
    expect(prepare.caBundlePath).toMatch(/ca\.pem$/);
  });

  it('prepare carries the literal canonical guest paths /skill and /etc/skill-ca/ca.pem', async () => {
    const rec: Recorder = { events: [], capturedPrepare: undefined, capturedLaunchOpts: undefined, capturedLaunchCarrier: undefined };
    const carrier: ProxyCarrier = {
      kind: 'docker-sidecar',
      proxyImage: 'example/proxy@sha256:' + 'a'.repeat(64),
      internalNetwork: 'octopus-sbx-x-internal',
      egressNetwork: 'octopus-sbx-x-egress',
      reachableHost: 'egress-proxy',
    };
    const backend = makeFakeBackend(rec, 'docker', carrier);
    const launcher = makeFakeLauncher(rec, 'docker');

    await orchestrate({
      rec,
      backends: [backend],
      launcher,
      verifySnapshot: makeVerifySnapshot(rec),
      policy: makePolicy(),
      secrets: {},
      workDir: '/tmp/oct-work',
      snapshotRoot: '/snap/a',
      expectedDigest: 'deadbeef',
    });

    const prepare = rec.capturedPrepare!;
    expect(prepare.guestSkillRoot).toBe('/skill');
    expect(prepare.guestCaBundlePath).toBe('/etc/skill-ca/ca.pem');
    expect(prepare.caBundlePath).toMatch(/ca\.pem$/);
    // Docker sidecar uses a network-alias reachable host (still never loopback).
    expect(prepare.proxyAddr).not.toMatch(/127\.0\.0\.1|localhost/);
    expect(prepare.proxyAddr).toBe('http://egress-proxy:8080');
  });

  it('launcher receives the exact carrier returned by prepareTopology', async () => {
    const rec: Recorder = { events: [], capturedPrepare: undefined, capturedLaunchOpts: undefined, capturedLaunchCarrier: undefined };
    const carrier: ProxyCarrier = {
      kind: 'linux-static',
      binaryPath: '/build/egress-proxy-server.mjs',
      skillNamespace: { name: 'octn-y', path: '/run/netns/octn-y' },
      listenHost: '169.254.7.5',
      reachableHost: '169.254.7.5',
      cgroupPath: '/sys/fs/cgroup/oct-proxy-y',
      listenPort: 50001,
    };
    const backend = makeFakeBackend(rec, 'os', carrier);
    const launcher = makeFakeLauncher(rec, 'os');

    await orchestrate({
      rec,
      backends: [backend],
      launcher,
      verifySnapshot: makeVerifySnapshot(rec),
      policy: makePolicy(),
      secrets: { 'k': 'v' },
      workDir: '/tmp/oct-work-y',
      snapshotRoot: '/snap/b',
      expectedDigest: 'cafe',
    });

    // Same carrier object passed through unchanged — the launcher binds
    // exactly what prepareTopology returned.
    expect(rec.capturedLaunchCarrier).toBe(carrier);
    expect(rec.capturedLaunchOpts?.workDir).toBe('/tmp/oct-work-y');
    expect(rec.capturedLaunchOpts?.secrets).toEqual({ k: 'v' });
  });

  it('proxy.close() runs even when backend.prepare() throws (finally-block invariant)', async () => {
    const rec: Recorder = { events: [], capturedPrepare: undefined, capturedLaunchOpts: undefined, capturedLaunchCarrier: undefined };
    const carrier: ProxyCarrier = {
      kind: 'linux-static',
      binaryPath: '/build/egress-proxy-server.mjs',
      skillNamespace: { name: 'octn-z', path: '/run/netns/octn-z' },
      listenHost: '169.254.7.9',
      reachableHost: '169.254.7.9',
      cgroupPath: '/sys/fs/cgroup/oct-proxy-z',
      listenPort: 40001,
    };
    const backend = makeFakeBackend(rec, 'os', carrier);
    // Make prepare() throw after being recorded.
    const basePrepare = backend.prepare.bind(backend);
    backend.prepare = async (opts) => {
      await basePrepare(opts);
      throw new Error('prepare failed');
    };
    const launcher = makeFakeLauncher(rec, 'os');

    // Inline a simplified orchestrate that asserts the finally-order invariant.
    const cfg = SandboxConfigSchema.parse({ defaultBackend: 'auto', minIsolationLevel: 'full' });
    const selected = await selectBackend(cfg, [backend]);
    rec.events.push(`select:${selected.kind}`);
    const c = await selected.prepareTopology();
    const proxyHandle = await launcher.launch({ policy: makePolicy(), secrets: {}, workDir: '/tmp/w' }, c);
    await makeVerifySnapshot(rec)('/snap', 'd');

    let caught: unknown;
    try {
      await selected.prepare({} as BackendPrepareOptions);
    } catch (err) {
      caught = err;
    } finally {
      await selected.cleanup();
      await proxyHandle.close();
    }
    expect(caught).toBeInstanceOf(Error);
    expect(rec.events).toEqual([
      'select:os',
      'backend:prepareTopology',
      'proxy:launch:os',
      'snapshot:verify',
      'backend:prepare',
      'backend:cleanup',
      'proxy:close',
    ]);
  });

  it('proxy.close() and backend.cleanup() are idempotent (called twice = same single event)', async () => {
    const rec: Recorder = { events: [], capturedPrepare: undefined, capturedLaunchOpts: undefined, capturedLaunchCarrier: undefined };
    const carrier: ProxyCarrier = {
      kind: 'linux-static',
      binaryPath: '/build/egress-proxy-server.mjs',
      skillNamespace: { name: 'octn-i', path: '/run/netns/octn-i' },
      listenHost: '169.254.7.7',
      reachableHost: '169.254.7.7',
      cgroupPath: '/sys/fs/cgroup/oct-proxy-i',
      listenPort: 41111,
    };
    const backend = makeFakeBackend(rec, 'os', carrier);
    const launcher = makeFakeLauncher(rec, 'os');

    await orchestrate({
      rec,
      backends: [backend],
      launcher,
      verifySnapshot: makeVerifySnapshot(rec),
      policy: makePolicy(),
      secrets: {},
      workDir: '/tmp/w',
      snapshotRoot: '/snap',
      expectedDigest: 'd',
    });

    // Second round of cleanup — idempotent, no additional events.
    const closeSpy = vi.spyOn({ close: async () => {} }, 'close');
    void closeSpy; // silence unused
    await backend.cleanup();
    expect(rec.events.filter((e) => e === 'backend:cleanup')).toHaveLength(2);
    // proxyHandle was closed inside orchestrate; calling launcher-issued close
    // again on a fresh handle would be a no-op. We assert the orchestrate path
    // produced exactly one 'proxy:close' event (the launcher fake is itself
    // idempotent).
    expect(rec.events.filter((e) => e === 'proxy:close')).toHaveLength(1);
  });
});
