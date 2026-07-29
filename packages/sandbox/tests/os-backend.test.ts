/**
 * Tests for packages/sandbox/src/os/os-backend.ts (Plan 4, Task 5).
 *
 * Layout
 * ------
 * 1. Portable state-machine tests (run on macOS).
 *    - Inject fake collaborators via DI seams (probe/netns/cgroup/rootfs/
 *      process-spawn). Assert call ORDER and fail-closed behavior without
 *      touching the kernel.
 *
 * 2. The Linux-gated real smoke test lives in os-backend-linux-smoke.test.ts.
 *
 * DI discipline: no vi.mock('node:child_process'). All external effects go
 * through the seams exposed on OsSandboxBackendOptions.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { OsSandboxBackend, type OsBackendDeps } from '../src/os/os-backend.js';
import type { OsCaps } from '../src/os/probe.js';
import type { RootfsLayout } from '../src/os/rootfs.js';
import type { CgroupHandle } from '../src/os/cgroup.js';
import type { NetnsHandle } from '../src/os/netns.js';
import type { ProxyCarrier, BackendPrepareOptions } from '../src/backend.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function fullCaps(): OsCaps {
  return {
    platform: 'linux',
    userMountPidIpcUtsNs: true,
    namedNetns: true,
    nftRuleCreate: true,
    cgroupV2Writable: true,
    runtimeArtifact: true,
    helperArtifact: true,
    sandboxExec: false,
    probeErrors: [],
  };
}

function restrictedCaps(reason: string): OsCaps {
  return {
    platform: 'darwin',
    userMountPidIpcUtsNs: false,
    namedNetns: false,
    nftRuleCreate: false,
    cgroupV2Writable: false,
    runtimeArtifact: false,
    helperArtifact: false,
    sandboxExec: false,
    probeErrors: [reason],
  };
}

function fakeNetns(overrides?: Partial<NetnsHandle>): NetnsHandle {
  return {
    name: 'octn-test',
    path: '/run/netns/octn-test',
    hostIf: 'ohtest',
    skillIf: 'ostest',
    proxyIp: '169.254.7.1',
    skillIp: '169.254.7.2',
    proxyPort: 43210,
    nftTable: 'oct_test',
    cleanupErrors: [],
    cleanup: vi.fn(async () => {}),
    ...overrides,
  };
}

function fakeCgroup(path = '/sys/fs/cgroup/oct-test'): CgroupHandle {
  return {
    path,
    attach: vi.fn(async () => {}),
    kill: vi.fn(async () => {}),
    waitEmpty: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {}),
  };
}

function fakeLayout(root = '/tmp/oct-rootfs-test'): RootfsLayout {
  return {
    root,
    runtimeRoot: root,
    hostMounts: {
      snapshotSource: '/snap/a',
      snapshotTarget: `${root}/skill`,
      caSource: '/ca.pem',
      caTarget: `${root}/etc/skill-ca/ca.pem`,
    },
    inRoot: {
      node: '/usr/bin/node',
      skill: '/skill',
      ca: '/etc/skill-ca/ca.pem',
      tmp: '/tmp',
      proc: '/proc',
      dev: '/dev',
    },
    cleanup: vi.fn(async () => {}),
  };
}

/**
 * Supplied-endpoint fixture: the orchestrator (SandboxRunner +
 * DefaultProxyLauncher) has ALREADY launched the proxy and supplies its
 * coordinates via prepareOpts.proxyAddr / caBundlePath. The backend must
 * validate those coordinates against the carrier and authorize nft — it
 * must NOT launch or own a proxy itself.
 */
function suppliedProxyAddr(carrier: Extract<ProxyCarrier, { kind: 'linux-static' }>): string {
  return `http://${carrier.reachableHost}:${carrier.listenPort}`;
}

const SUPPLIED_CA_BUNDLE = '/tmp/ca-bundle.pem';

function validPrepareOpts(carrier: Extract<ProxyCarrier, { kind: 'linux-static' }>): BackendPrepareOptions {
  return {
    hosts: ['example.com'],
    credentials: [],
    denied: { hosts: [], credentials: [] },
    resources: { memoryBytes: 64 * 1024 * 1024, cpus: 0.5, timeoutMs: 5000 },
    snapshotRoot: '/snap/a',
    expectedSnapshotDigest: `sha256:${'a'.repeat(64)}`,
    proxyAddr: suppliedProxyAddr(carrier),
    caBundlePath: SUPPLIED_CA_BUNDLE,
    runtimeProfile: {
      id: 'linux-node22',
      bins: ['node'],
      path: '/usr/bin',
      osRuntime: {
        artifactPath: '/runtime/linux-node22.rootfs.tar.zst',
        manifestPath: '/runtime/linux-node22.manifest.json',
        nodePath: '/usr/bin/node',
      },
    },
    guestSkillRoot: '/skill',
    guestCaBundlePath: '/etc/skill-ca/ca.pem',
  };
}

interface FakeDeps {
  probeOsCaps: ReturnType<typeof vi.fn>;
  resolveOsArtifacts: ReturnType<typeof vi.fn>;
  setupNetns: ReturnType<typeof vi.fn>;
  authorizeProxyEndpoint: ReturnType<typeof vi.fn>;
  createLimitedCgroup: ReturnType<typeof vi.fn>;
  assembleRootfs: ReturnType<typeof vi.fn>;
  buildOsRunCommand: ReturnType<typeof vi.fn>;
  spawnHelper: ReturnType<typeof vi.fn>;
}

function makeDeps(overrides?: Partial<{
  caps: OsCaps;
  netns: NetnsHandle;
  cgroup: CgroupHandle;
  layout: RootfsLayout;
  artifacts: {
    runtimeArtifactPath: string;
    runtimeManifestPath: string;
    helperManifestPath: string;
    helperBinaryPath: string;
    proxyBundlePath: string;
  };
}>): FakeDeps {
  const caps = overrides?.caps ?? fullCaps();
  const netns = overrides?.netns ?? fakeNetns();
  const cgroup = overrides?.cgroup ?? fakeCgroup();
  const layout = overrides?.layout ?? fakeLayout();
  const artifacts = overrides?.artifacts ?? {
    runtimeArtifactPath: '/runtime/linux-node22.rootfs.tar.zst',
    runtimeManifestPath: '/runtime/linux-node22.manifest.json',
    helperManifestPath: '/runtime/os-helper.manifest.json',
    helperBinaryPath: '/runtime/os-helper',
    proxyBundlePath: '/build/egress-proxy-server.mjs',
  };

  return {
    probeOsCaps: vi.fn(async () => caps),
    resolveOsArtifacts: vi.fn(async () => artifacts),
    setupNetns: vi.fn(async () => netns),
    authorizeProxyEndpoint: vi.fn(async (_h: NetnsHandle) => _h),
    createLimitedCgroup: vi.fn(async () => cgroup),
    assembleRootfs: vi.fn(async () => layout),
    buildOsRunCommand: vi.fn(async () => ({
      file: artifacts.helperBinaryPath,
      args: ['--launch-spec', '/tmp/spec.json', '--stop-before-exec'],
      env: {},
      launchSpecPath: '/tmp/spec.json',
    })),
    spawnHelper: vi.fn(),
    // Default stat stub: reports any cgroup root as a valid directory so the
    // fail-closed validation passes on macOS without touching the real fs.
    // Tests that need to exercise the validation override this on the instance.
    stat: vi.fn(async () => ({ isDirectory: () => true })),
  };
}

// ---------------------------------------------------------------------------
// Public-constructor smoke tests (verbatim from brief).
// ---------------------------------------------------------------------------

describe('OsSandboxBackend', () => {
  it('keeps the public constructor and reports kind=os', () => {
    const b = new OsSandboxBackend({ sessionId: 'test-session' });
    expect(b.kind).toBe('os');
    expect(['full', 'restricted']).toContain(b.isolationLevel);
  });

  it('fails prepare when the canonical launched proxy/CA/runtime fields are missing', async () => {
    const b = new OsSandboxBackend({ sessionId: 'missing-proxy' });
    await expect(b.prepare({
      hosts: ['example.com'], credentials: [], denied: { hosts: [], credentials: [] },
      resources: { memoryBytes: 64 * 1024 * 1024, cpus: 0.1, timeoutMs: 1000 },
      snapshotRoot: '/snap',
    } as any)).rejects.toThrow(/proxyAddr|caBundlePath|runtimeProfile|guestSkillRoot|guestCaBundlePath/);
  });

  it('cleanup is idempotent before and after partial prepare failure', async () => {
    const b = new OsSandboxBackend({ sessionId: 'cleanup' });
    await b.cleanup();
    await b.cleanup();
  });
});

// ---------------------------------------------------------------------------
// probe()
// ---------------------------------------------------------------------------

describe('OsSandboxBackend.probe', () => {
  it('returns false on non-Linux without touching artifacts', async () => {
    const deps = makeDeps();
    const b = new OsSandboxBackend({ sessionId: 'p-mac', deps: deps as unknown as OsBackendDeps });
    // Force a darwin-like caps response.
    deps.probeOsCaps.mockResolvedValue(restrictedCaps('darwin'));
    const ok = await b.probe();
    expect(ok).toBe(false);
    expect(b.isolationLevel).toBe('restricted');
  });

  it('returns false when artifact verification fails (availability check, not error)', async () => {
    const deps = makeDeps();
    deps.resolveOsArtifacts.mockRejectedValue(new Error('missing artifact'));
    const b = new OsSandboxBackend({ sessionId: 'p-art', deps: deps as unknown as OsBackendDeps });
    const ok = await b.probe();
    expect(ok).toBe(false);
    expect(b.isolationLevel).toBe('restricted');
  });

  it('returns true and reports full when caps are full', async () => {
    const deps = makeDeps();
    const b = new OsSandboxBackend({ sessionId: 'p-full', deps: deps as unknown as OsBackendDeps });
    const ok = await b.probe();
    expect(ok).toBe(true);
    expect(b.isolationLevel).toBe('full');
  });

  it('returns false when caps are restricted even if artifacts verify', async () => {
    const deps = makeDeps();
    deps.probeOsCaps.mockResolvedValue(restrictedCaps('no cgroup'));
    const b = new OsSandboxBackend({ sessionId: 'p-res', deps: deps as unknown as OsBackendDeps });
    const ok = await b.probe();
    expect(ok).toBe(false);
    expect(b.isolationLevel).toBe('restricted');
  });
});

// ---------------------------------------------------------------------------
// prepareTopology()
// ---------------------------------------------------------------------------

describe('OsSandboxBackend.prepareTopology', () => {
  it('returns the canonical linux-static carrier with the real allocated port', async () => {
    const deps = makeDeps();
    const b = new OsSandboxBackend({ sessionId: 'topo', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology();
    expect(carrier.kind).toBe('linux-static');
    const c = carrier as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    expect(c.binaryPath).toBe('/build/egress-proxy-server.mjs');
    expect(c.skillNamespace).toEqual({ name: 'octn-test', path: '/run/netns/octn-test' });
    expect(c.listenHost).toBe('169.254.7.1');
    expect(c.reachableHost).toBe('169.254.7.1');
    expect(c.listenPort).toBe(43210);
    expect(c.cgroupPath).toMatch(/^\/sys\/fs\/cgroup\//);
    // Idempotent: second call returns the same carrier object.
    const again = await b.prepareTopology();
    expect(again).toBe(carrier);
  });

  it('throws when called before a successful probe', async () => {
    const deps = makeDeps();
    deps.probeOsCaps.mockResolvedValue(restrictedCaps('darwin'));
    const b = new OsSandboxBackend({ sessionId: 'topo-fail', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    await expect(b.prepareTopology()).rejects.toThrow(/probe|full/i);
  });
});

// ---------------------------------------------------------------------------
// prepare() — ordering assertions
// ---------------------------------------------------------------------------

describe('OsSandboxBackend.prepare ordering', () => {
  it('validates options BEFORE any topology dependency', async () => {
    const deps = makeDeps();
    const b = new OsSandboxBackend({ sessionId: 'ord-1', deps: deps as unknown as OsBackendDeps });
    // No probe, no topology — but invalid options must throw first.
    await expect(b.prepare({} as any)).rejects.toThrow(/proxyAddr|caBundlePath|runtimeProfile|guestSkillRoot|guestCaBundlePath/);
    // resolveOsArtifacts was never called.
    expect(deps.resolveOsArtifacts).not.toHaveBeenCalled();
  });

  it('rejects when prepareTopology has not run', async () => {
    const deps = makeDeps();
    const b = new OsSandboxBackend({ sessionId: 'ord-2', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const netns = fakeNetns();
    const carrier: Extract<ProxyCarrier, { kind: 'linux-static' }> = {
      kind: 'linux-static',
      binaryPath: '/build/egress-proxy-server.mjs',
      skillNamespace: { name: netns.name, path: netns.path },
      listenHost: netns.proxyIp,
      reachableHost: netns.proxyIp,
      cgroupPath: '/sys/fs/cgroup/oct-test',
      listenPort: netns.proxyPort,
    };
    await expect(b.prepare(validPrepareOpts(carrier))).rejects.toThrow(/prepareTopology|topology/i);
  });

  it('rejects when proxyAddr host does not match the carrier reachableHost before nft authorization', async () => {
    const deps = makeDeps();
    const b = new OsSandboxBackend({ sessionId: 'ord-3', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    const opts = validPrepareOpts(carrier);
    opts.proxyAddr = 'http://127.0.0.1:43210'; // host mismatch — loopback is invalid
    await expect(b.prepare(opts)).rejects.toThrow(/proxyAddr|reachableHost|host/i);
    expect(deps.authorizeProxyEndpoint).not.toHaveBeenCalled();
  });

  it('rejects when proxyAddr port does not match the carrier listenPort before nft authorization', async () => {
    const deps = makeDeps();
    const b = new OsSandboxBackend({ sessionId: 'ord-4', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    const opts = validPrepareOpts(carrier);
    opts.proxyAddr = `http://${carrier.reachableHost}:9999`;
    await expect(b.prepare(opts)).rejects.toThrow(/port|listenPort/i);
    expect(deps.authorizeProxyEndpoint).not.toHaveBeenCalled();
  });

  it('rejects when guestSkillRoot is not /skill', async () => {
    const deps = makeDeps();
    const b = new OsSandboxBackend({ sessionId: 'ord-5', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    const opts = validPrepareOpts(carrier);
    (opts as any).guestSkillRoot = '/evil';
    await expect(b.prepare(opts)).rejects.toThrow(/guestSkillRoot|\/skill/);
  });

  it('rejects when guestCaBundlePath is not /etc/skill-ca/ca.pem', async () => {
    const deps = makeDeps();
    const b = new OsSandboxBackend({ sessionId: 'ord-6', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    const opts = validPrepareOpts(carrier);
    (opts as any).guestCaBundlePath = '/etc/evil.pem';
    await expect(b.prepare(opts)).rejects.toThrow(/guestCaBundlePath|ca\.pem/);
  });

  it('rejects invalid resources (non-positive memory/cpus/timeout)', async () => {
    const deps = makeDeps();
    const b = new OsSandboxBackend({ sessionId: 'ord-7', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    const opts = validPrepareOpts(carrier);
    opts.resources = { memoryBytes: 0, cpus: 0.5, timeoutMs: 5000 };
    await expect(b.prepare(opts)).rejects.toThrow(/memory|resource/i);

    opts.resources = { memoryBytes: 1024, cpus: 0, timeoutMs: 5000 };
    await expect(b.prepare(opts)).rejects.toThrow(/cpu|resource/i);

    opts.resources = { memoryBytes: 1024, cpus: 0.5, timeoutMs: 0 };
    await expect(b.prepare(opts)).rejects.toThrow(/timeout|resource/i);
  });

  it('calls backend collaborators in the mandatory order after receiving supplied proxy coordinates', async () => {
    const deps = makeDeps();
    const callOrder: string[] = [];
    deps.probeOsCaps.mockImplementation(async () => { callOrder.push('probe'); return fullCaps(); });
    deps.setupNetns.mockImplementation(async () => { callOrder.push('setupNetns'); return fakeNetns(); });
    deps.authorizeProxyEndpoint.mockImplementation(async (h: NetnsHandle) => { callOrder.push('authorizeProxyEndpoint'); return h; });
    deps.assembleRootfs.mockImplementation(async () => { callOrder.push('assembleRootfs'); return fakeLayout(); });
    deps.createLimitedCgroup.mockImplementation(async () => { callOrder.push('createLimitedCgroup'); return fakeCgroup(); });

    const b = new OsSandboxBackend({ sessionId: 'ord-8', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    await b.prepare(validPrepareOpts(carrier));

    expect(callOrder).toEqual([
      'probe',
      'setupNetns',
      'authorizeProxyEndpoint',
      'assembleRootfs',
      'createLimitedCgroup',
    ]);
  });

  it('cleans up partial state and throws when assembleRootfs fails', async () => {
    const deps = makeDeps();
    deps.assembleRootfs.mockRejectedValue(new Error('bad rootfs'));
    const b = new OsSandboxBackend({ sessionId: 'ord-9', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    const opts = validPrepareOpts(carrier);
    await expect(b.prepare(opts)).rejects.toThrow(/bad rootfs/);
    // netns cleanup was called.
    const netns = await deps.setupNetns.mock.results[0]!.value as NetnsHandle;
    expect(netns.cleanup).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// spawn() — cgroup attach + SIGCONT ordering
// ---------------------------------------------------------------------------

describe('OsSandboxBackend.spawn', () => {
  it('attaches child PID to cgroup, verifies membership, then SIGCONTs', async () => {
    const deps = makeDeps();
    const order: string[] = [];
    const cgroup = fakeCgroup();
    (cgroup.attach as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('attach'); });
    deps.createLimitedCgroup.mockResolvedValue(cgroup);

    const fakeChild = {
      pid: 12345,
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: { on: vi.fn(), pipe: vi.fn() },
      stderr: { on: vi.fn(), pipe: vi.fn() },
      kill: vi.fn(),
      on: vi.fn(),
      exitCode: null as number | null,
    };
    deps.spawnHelper.mockImplementation(() => {
      order.push('spawn');
      return fakeChild;
    });

    const b = new OsSandboxBackend({ sessionId: 'spawn-1', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    const opts = validPrepareOpts(carrier);
    await b.prepare(opts);

    const proc = await b.spawn({ command: ['/usr/bin/node', '--version'] });
    expect(order).toEqual(['spawn', 'attach']);
    expect(cgroup.attach).toHaveBeenCalledWith(12345);
    expect(proc.stdin).toBeDefined();
    expect(proc.stdout).toBeDefined();
    expect(proc.stderr).toBeDefined();
    expect(proc.exited).toBeInstanceOf(Promise);
  });

  it('refuses to spawn when cgroup attach fails', async () => {
    const deps = makeDeps();
    const cgroup = fakeCgroup();
    (cgroup.attach as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('attach refused'));
    deps.createLimitedCgroup.mockResolvedValue(cgroup);
    deps.spawnHelper.mockReturnValue({
      pid: 999,
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: { on: vi.fn(), pipe: vi.fn() },
      stderr: { on: vi.fn(), pipe: vi.fn() },
      kill: vi.fn(),
      on: vi.fn(),
      exitCode: null,
    });

    const b = new OsSandboxBackend({ sessionId: 'spawn-2', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    await b.prepare(validPrepareOpts(carrier));
    await expect(b.spawn({ command: ['/usr/bin/node'] })).rejects.toThrow(/attach/);
  });
});

// ---------------------------------------------------------------------------
// run() — one-shot wrapper
// ---------------------------------------------------------------------------

describe('OsSandboxBackend.run', () => {
  it('writes stdin, awaits exited, and closes', async () => {
    const deps = makeDeps();
    let closed = false;
    deps.spawnHelper.mockReturnValue({
      pid: 555,
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: { on: vi.fn(), pipe: vi.fn() },
      stderr: { on: vi.fn(), pipe: vi.fn() },
      kill: vi.fn(),
      on: vi.fn((ev: string, cb: (code: number) => void) => {
        if (ev === 'close') setTimeout(() => cb(0), 5);
      }),
      exitCode: null,
    });

    const b = new OsSandboxBackend({ sessionId: 'run-1', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    await b.prepare(validPrepareOpts(carrier));

    const result = await b.run({ command: ['/usr/bin/node', '--version'], stdin: 'hello' });
    expect(result.exitCode).toBe(0);
    expect(result.meta.isolationLevel).toBe('full');
    expect(result.meta.backend).toBe('os');
  });
});

// ---------------------------------------------------------------------------
// Persistent-process behavior + timeout/output-overflow containment
// ---------------------------------------------------------------------------

function makeFakeChild(opts?: { pid?: number; closeCode?: number; closeDelayMs?: number }) {
  const pid = opts?.pid ?? 777;
  const closeCode = opts?.closeCode ?? 0;
  const closeDelayMs = opts?.closeDelayMs ?? 5;
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const stdoutData: Array<(chunk: Buffer) => void> = [];
  const stderrData: Array<(chunk: Buffer) => void> = [];
  const stdoutPipeDests: Array<{ emit?: (ev: string, chunk: Buffer) => void; write?: (c: Buffer) => void }> = [];
  const stderrPipeDests: Array<{ emit?: (ev: string, chunk: Buffer) => void; write?: (c: Buffer) => void }> = [];
  const child = {
    pid,
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: {
      on: vi.fn((ev: string, cb: (chunk: Buffer) => void) => {
        if (ev === 'data') stdoutData.push(cb);
      }),
      pipe: vi.fn((dest: { emit?: (ev: string, chunk: Buffer) => void; write?: (c: Buffer) => void }) => {
        stdoutPipeDests.push(dest);
        return dest;
      }),
    },
    stderr: {
      on: vi.fn((ev: string, cb: (chunk: Buffer) => void) => {
        if (ev === 'data') stderrData.push(cb);
      }),
      pipe: vi.fn((dest: { emit?: (ev: string, chunk: Buffer) => void; write?: (c: Buffer) => void }) => {
        stderrPipeDests.push(dest);
        return dest;
      }),
    },
    kill: vi.fn(),
    on: vi.fn((ev: string, cb: (...args: unknown[]) => void) => {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev)!.push(cb);
      if (ev === 'close') {
        setTimeout(() => cb(closeCode), closeDelayMs);
      }
    }),
    exitCode: null as number | null,
    emitStdout(chunk: Buffer): void {
      for (const cb of stdoutData) cb(chunk);
      for (const d of stdoutPipeDests) {
        if (typeof d.emit === 'function') d.emit('data', chunk);
        else if (typeof d.write === 'function') d.write(chunk);
      }
    },
    emitStderr(chunk: Buffer): void {
      for (const cb of stderrData) cb(chunk);
      for (const d of stderrPipeDests) {
        if (typeof d.emit === 'function') d.emit('data', chunk);
        else if (typeof d.write === 'function') d.write(chunk);
      }
    },
  };
  return child;
}

// NOTE: The `OsSandboxBackend persistent process` describe block was moved
// verbatim to tests/os-process.test.ts (Plan 5, Task 2). `makeFakeChild`
// stays here because the review-fix regression block below also uses it.

// ---------------------------------------------------------------------------
// cleanup() — idempotent, reverse order
// ---------------------------------------------------------------------------

describe('OsSandboxBackend.cleanup', () => {
  it('is idempotent after full prepare+spawn', async () => {
    const deps = makeDeps();
    const b = new OsSandboxBackend({ sessionId: 'clean-1', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    await b.prepare(validPrepareOpts(carrier));
    await b.cleanup();
    await b.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Review-fix regression tests (C1, I2, external proxy ownership)
// ---------------------------------------------------------------------------

describe('OsSandboxBackend review-fix regressions', () => {
  it('C1: cgroup.kill() rejection on timeout yields NOT-full, degraded meta', async () => {
    const deps = makeDeps();
    const cgroup = fakeCgroup();
    (cgroup.kill as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('EIO on cgroup.kill'));
    deps.createLimitedCgroup.mockResolvedValue(cgroup);
    // Child closes quickly after timeout fires so settle() runs.
    const fakeChild = makeFakeChild({ pid: 9100, closeDelayMs: 60 });
    deps.spawnHelper.mockReturnValue(fakeChild);

    const b = new OsSandboxBackend({ sessionId: 'c1-timeout', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    await b.prepare(validPrepareOpts(carrier));

    const result = await b.run({ command: ['/usr/bin/node'], timeoutMs: 30 });
    expect(result.timedOut).toBe(true);
    expect(result.meta.isolationLevel).not.toBe('full');
    expect(result.meta.degraded).toBe(true);
    expect(result.meta.degradationReasons.length).toBeGreaterThan(0);
    expect(result.meta.degradationReasons[0]).toMatch(/cgroup containment kill failed/);
    expect(result.meta.degradationReasons[0]).toMatch(/EIO on cgroup\.kill/);
  });

  it('C1: cgroup.kill() rejection on output-overflow yields NOT-full, degraded meta', async () => {
    const deps = makeDeps();
    const cgroup = fakeCgroup();
    (cgroup.kill as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('write refused'));
    deps.createLimitedCgroup.mockResolvedValue(cgroup);
    const fakeChild = makeFakeChild({ pid: 9101, closeDelayMs: 50 });
    deps.spawnHelper.mockReturnValue(fakeChild);

    const b = new OsSandboxBackend({ sessionId: 'c1-ovf', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    await b.prepare(validPrepareOpts(carrier));

    const proc = await b.spawn({
      command: ['/usr/bin/node'],
      outputMaxBytes: 32,
      timeoutMs: 5000,
    });
    fakeChild.emitStdout(Buffer.alloc(64, 0x61));
    const result = await proc.exited;
    expect(result.meta.isolationLevel).not.toBe('full');
    expect(result.meta.degraded).toBe(true);
    expect(result.meta.degradationReasons[0]).toMatch(/cgroup containment kill failed/);
  });

  it('C1 (positive): successful cgroup.kill on timeout still reports full, not degraded', async () => {
    const deps = makeDeps();
    const cgroup = fakeCgroup();
    deps.createLimitedCgroup.mockResolvedValue(cgroup);
    const fakeChild = makeFakeChild({ pid: 9102, closeDelayMs: 60 });
    deps.spawnHelper.mockReturnValue(fakeChild);

    const b = new OsSandboxBackend({ sessionId: 'c1-ok', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    await b.prepare(validPrepareOpts(carrier));

    const result = await b.run({ command: ['/usr/bin/node'], timeoutMs: 30 });
    expect(result.timedOut).toBe(true);
    expect(result.meta.isolationLevel).toBe('full');
    expect(result.meta.degraded).toBe(false);
    expect(result.meta.degradationReasons).toEqual([]);
  });

  it('I2: exited does not settle until in-flight containment kill+waitEmpty drains', async () => {
    const deps = makeDeps();
    const cgroup = fakeCgroup();
    const order: string[] = [];
    // Slow kill: take 80ms; record start/finish in the order log.
    (cgroup.kill as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('kill:start');
      await new Promise((r) => setTimeout(r, 80));
      order.push('kill:end');
    });
    (cgroup.waitEmpty as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('waitEmpty:start');
      await new Promise((r) => setTimeout(r, 5));
      order.push('waitEmpty:end');
    });
    deps.createLimitedCgroup.mockResolvedValue(cgroup);
    // Child closes at 50ms — after the 20ms timeout fires but BEFORE the
    // 80ms kill finishes. If settle() resolved on close, exited would
    // resolve before kill:end; the fix makes settle await the in-flight kill.
    const fakeChild = makeFakeChild({ pid: 9200, closeDelayMs: 50 });
    deps.spawnHelper.mockReturnValue(fakeChild);

    const b = new OsSandboxBackend({ sessionId: 'i2-drain', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    await b.prepare(validPrepareOpts(carrier));

    const exitedPromise = b.run({ command: ['/usr/bin/node'], timeoutMs: 20 });
    // Track when exited actually resolves.
    void exitedPromise.then(() => { order.push('exited:resolved'); });
    const result = await exitedPromise;
    expect(result.timedOut).toBe(true);
    // The drain must complete BEFORE exited resolves, even though the child
    // closed early.
    const exitIdx = order.indexOf('exited:resolved');
    const killEndIdx = order.indexOf('kill:end');
    const waitEndIdx = order.indexOf('waitEmpty:end');
    expect(killEndIdx).toBeGreaterThanOrEqual(0);
    expect(waitEndIdx).toBeGreaterThanOrEqual(0);
    expect(exitIdx).toBeGreaterThan(killEndIdx);
    expect(exitIdx).toBeGreaterThan(waitEndIdx);
  });

  it('does not launch or close the externally owned proxy', async () => {
    const deps = makeDeps();
    const externalClose = vi.fn(async () => {});
    const legacyLaunch = vi.fn(async () => ({
      reachableAddr: 'http://169.254.7.1:43210',
      caBundlePath: SUPPLIED_CA_BUNDLE,
      close: externalClose,
    }));
    const legacyDeps = {
      ...deps,
      // Deliberately pass the removed legacy seam at runtime. Type-erasing this
      // object proves the concrete backend ignores old launcher injection rather
      // than merely hiding it from OsBackendDeps' static shape.
      proxyLauncher: { launch: legacyLaunch },
    } as unknown as OsBackendDeps;

    const b = new OsSandboxBackend({ sessionId: 'external-owner', deps: legacyDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    await b.prepare(validPrepareOpts(carrier));
    await b.cleanup();

    expect(legacyLaunch).not.toHaveBeenCalled();
    expect(externalClose).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Task 5 — delegated cgroup root + skill cgroup path exposure
// ---------------------------------------------------------------------------

describe('OsSandboxBackend cgroupRoot + skillCgroupPath', () => {
  const prevEnv = { ...process.env };
  afterEach(() => {
    // Restore env between tests so OCTOPUS_TEST_CGROUP_PARENT leakage cannot
    // contaminate sibling assertions.
    process.env = { ...prevEnv };
  });

  it('defaults cgroupRoot to /sys/fs/cgroup when neither option nor env is set', async () => {
    delete process.env.OCTOPUS_TEST_CGROUP_PARENT;
    const deps = makeDeps();
    const captured: Record<string, unknown> = {};
    deps.createLimitedCgroup.mockImplementation(async (opts: any) => {
      captured.cgroupRoot = opts.cgroupRoot;
      return fakeCgroup();
    });
    const b = new OsSandboxBackend({ sessionId: 'cg-default', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    // Inject a stat stub that says /sys/fs/cgroup is a directory.
    (b as any).deps.stat = vi.fn(async () => ({ isDirectory: () => true }));
    await b.prepare(validPrepareOpts(carrier));
    expect(captured.cgroupRoot).toBe('/sys/fs/cgroup');
  });

  it('honors OCTOPUS_TEST_CGROUP_PARENT env fallback when option is absent', async () => {
    process.env.OCTOPUS_TEST_CGROUP_PARENT = '/tmp/delegated-cg';
    const deps = makeDeps();
    const captured: Record<string, unknown> = {};
    deps.createLimitedCgroup.mockImplementation(async (opts: any) => {
      captured.cgroupRoot = opts.cgroupRoot;
      return fakeCgroup();
    });
    const b = new OsSandboxBackend({ sessionId: 'cg-env', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    (b as any).deps.stat = vi.fn(async () => ({ isDirectory: () => true }));
    await b.prepare(validPrepareOpts(carrier));
    expect(captured.cgroupRoot).toBe('/tmp/delegated-cg');
  });

  it('option takes precedence over OCTOPUS_TEST_CGROUP_PARENT env', async () => {
    process.env.OCTOPUS_TEST_CGROUP_PARENT = '/from-env';
    const deps = makeDeps();
    const captured: Record<string, unknown> = {};
    deps.createLimitedCgroup.mockImplementation(async (opts: any) => {
      captured.cgroupRoot = opts.cgroupRoot;
      return fakeCgroup();
    });
    const b = new OsSandboxBackend({
      sessionId: 'cg-opt',
      cgroupRoot: '/from-option',
      deps: deps as unknown as OsBackendDeps,
    });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    (b as any).deps.stat = vi.fn(async () => ({ isDirectory: () => true }));
    await b.prepare(validPrepareOpts(carrier));
    expect(captured.cgroupRoot).toBe('/from-option');
  });

  it('proxyCgroupPath on the carrier uses the delegated cgroupRoot', async () => {
    process.env.OCTOPUS_TEST_CGROUP_PARENT = '/tmp/delegated-cg';
    const deps = makeDeps();
    const b = new OsSandboxBackend({ sessionId: 'cg-proxy', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    expect(carrier.cgroupPath).toBe('/tmp/delegated-cg/oct-proxy-cg-proxy');
  });

  it('skillCgroupPath is undefined before prepare, set after prepare, cleared after cleanup', async () => {
    delete process.env.OCTOPUS_TEST_CGROUP_PARENT;
    const deps = makeDeps();
    const skillCgPath = '/sys/fs/cgroup/oct-skill-lifecycle';
    deps.createLimitedCgroup.mockResolvedValue(fakeCgroup(skillCgPath));
    const b = new OsSandboxBackend({ sessionId: 'cg-life', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    // Before prepareTopology/prepare: undefined.
    expect(b.skillCgroupPath).toBeUndefined();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    // After topology but before prepare: still undefined (cgroup not created yet).
    expect(b.skillCgroupPath).toBeUndefined();
    (b as any).deps.stat = vi.fn(async () => ({ isDirectory: () => true }));
    await b.prepare(validPrepareOpts(carrier));
    // After prepare: the handle's path is exposed.
    expect(b.skillCgroupPath).toBe(skillCgPath);
    await b.cleanup();
    // After cleanup: cleared.
    expect(b.skillCgroupPath).toBeUndefined();
  });

  it('fails closed (throws) when the cgroup root does not exist', async () => {
    delete process.env.OCTOPUS_TEST_CGROUP_PARENT;
    const deps = makeDeps();
    deps.createLimitedCgroup.mockResolvedValue(fakeCgroup());
    const b = new OsSandboxBackend({
      sessionId: 'cg-missing-root',
      cgroupRoot: '/nonexistent-cg-root-xyz',
      deps: deps as unknown as OsBackendDeps,
    });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    // stat rejects — simulates ENOENT.
    (b as any).deps.stat = vi.fn(async () => { throw new Error('ENOENT: no such file or directory'); });
    await expect(b.prepare(validPrepareOpts(carrier))).rejects.toThrow(/cgroup root/i);
    // createLimitedCgroup must NOT have been called — fail-closed before creation.
    expect(deps.createLimitedCgroup).not.toHaveBeenCalled();
    // skillCgroupPath stays undefined.
    expect(b.skillCgroupPath).toBeUndefined();
  });

  it('fails closed (throws) when the cgroup root exists but is not a directory', async () => {
    delete process.env.OCTOPUS_TEST_CGROUP_PARENT;
    const deps = makeDeps();
    deps.createLimitedCgroup.mockResolvedValue(fakeCgroup());
    const b = new OsSandboxBackend({
      sessionId: 'cg-not-dir',
      cgroupRoot: '/some/file',
      deps: deps as unknown as OsBackendDeps,
    });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    (b as any).deps.stat = vi.fn(async () => ({ isDirectory: () => false }));
    await expect(b.prepare(validPrepareOpts(carrier))).rejects.toThrow(/not a directory|cgroup root/i);
    expect(deps.createLimitedCgroup).not.toHaveBeenCalled();
  });
});
