/**
 * Tests for packages/sandbox/src/os/os-backend.ts (Plan 4, Task 5).
 *
 * Layout
 * ------
 * 1. Portable state-machine tests (run on macOS).
 *    - Inject fake collaborators via DI seams (probe/netns/cgroup/rootfs/
 *      proxy launcher/process-spawn). Assert call ORDER and fail-closed
 *      behavior without touching the kernel.
 *
 * 2. The Linux-gated real smoke test lives in os-backend-linux-smoke.test.ts.
 *
 * DI discipline: no vi.mock('node:child_process'). All external effects go
 * through the seams exposed on OsSandboxBackendOptions.
 */
import { describe, it, expect, vi } from 'vitest';
import { OsSandboxBackend, type OsBackendDeps } from '../src/os/os-backend.js';
import type { OsCaps } from '../src/os/probe.js';
import type { RootfsLayout } from '../src/os/rootfs.js';
import type { CgroupHandle } from '../src/os/cgroup.js';
import type { NetnsHandle } from '../src/os/netns.js';
import type { ProxyCarrier, BackendPrepareOptions } from '../src/backend.js';
import type { ProxyHandle, ProxyLauncher } from '../src/proxy/launcher.js';

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

function fakeProxyHandle(carrier: Extract<ProxyCarrier, { kind: 'linux-static' }>): ProxyHandle {
  return {
    reachableAddr: `http://${carrier.reachableHost}:${carrier.listenPort}`,
    caBundlePath: '/tmp/ca-bundle.pem',
    close: vi.fn(async () => {}),
  };
}

function validPrepareOpts(carrier: Extract<ProxyCarrier, { kind: 'linux-static' }>, proxy: ProxyHandle): BackendPrepareOptions {
  return {
    hosts: ['example.com'],
    credentials: [],
    denied: { hosts: [], credentials: [] },
    resources: { memoryBytes: 64 * 1024 * 1024, cpus: 0.5, timeoutMs: 5000 },
    snapshotRoot: '/snap/a',
    proxyAddr: proxy.reachableAddr,
    caBundlePath: proxy.caBundlePath,
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
  proxyLauncher: ProxyLauncher;
}

function makeDeps(overrides?: Partial<{
  caps: OsCaps;
  netns: NetnsHandle;
  cgroup: CgroupHandle;
  layout: RootfsLayout;
  proxyHandle: ProxyHandle;
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

  const carrier: Extract<ProxyCarrier, { kind: 'linux-static' }> = {
    kind: 'linux-static',
    binaryPath: artifacts.proxyBundlePath,
    skillNamespace: { name: netns.name, path: netns.path },
    listenHost: netns.proxyIp,
    reachableHost: netns.proxyIp,
    cgroupPath: cgroup.path,
    listenPort: netns.proxyPort,
  };
  const proxyHandle = overrides?.proxyHandle ?? fakeProxyHandle(carrier);

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
    proxyLauncher: {
      launch: vi.fn(async () => proxyHandle),
    },
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
    const proxy = fakeProxyHandle(carrier);
    await expect(b.prepare(validPrepareOpts(carrier, proxy))).rejects.toThrow(/prepareTopology|topology/i);
  });

  it('rejects when proxyAddr host does not match the carrier reachableHost', async () => {
    const deps = makeDeps();
    const b = new OsSandboxBackend({ sessionId: 'ord-3', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    const proxy = fakeProxyHandle(carrier);
    const opts = validPrepareOpts(carrier, proxy);
    opts.proxyAddr = 'http://127.0.0.1:43210'; // host mismatch — loopback is invalid
    await expect(b.prepare(opts)).rejects.toThrow(/proxyAddr|reachableHost|host/i);
  });

  it('rejects when proxyAddr port does not match the carrier listenPort', async () => {
    const deps = makeDeps();
    const b = new OsSandboxBackend({ sessionId: 'ord-4', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    const proxy = fakeProxyHandle(carrier);
    const opts = validPrepareOpts(carrier, proxy);
    opts.proxyAddr = `http://${carrier.reachableHost}:9999`;
    await expect(b.prepare(opts)).rejects.toThrow(/port|listenPort/i);
  });

  it('rejects when guestSkillRoot is not /skill', async () => {
    const deps = makeDeps();
    const b = new OsSandboxBackend({ sessionId: 'ord-5', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    const proxy = fakeProxyHandle(carrier);
    const opts = validPrepareOpts(carrier, proxy);
    (opts as any).guestSkillRoot = '/evil';
    await expect(b.prepare(opts)).rejects.toThrow(/guestSkillRoot|\/skill/);
  });

  it('rejects when guestCaBundlePath is not /etc/skill-ca/ca.pem', async () => {
    const deps = makeDeps();
    const b = new OsSandboxBackend({ sessionId: 'ord-6', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    const proxy = fakeProxyHandle(carrier);
    const opts = validPrepareOpts(carrier, proxy);
    (opts as any).guestCaBundlePath = '/etc/evil.pem';
    await expect(b.prepare(opts)).rejects.toThrow(/guestCaBundlePath|ca\.pem/);
  });

  it('rejects invalid resources (non-positive memory/cpus/timeout)', async () => {
    const deps = makeDeps();
    const b = new OsSandboxBackend({ sessionId: 'ord-7', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    const proxy = fakeProxyHandle(carrier);
    const opts = validPrepareOpts(carrier, proxy);
    opts.resources = { memoryBytes: 0, cpus: 0.5, timeoutMs: 5000 };
    await expect(b.prepare(opts)).rejects.toThrow(/memory|resource/i);

    opts.resources = { memoryBytes: 1024, cpus: 0, timeoutMs: 5000 };
    await expect(b.prepare(opts)).rejects.toThrow(/cpu|resource/i);

    opts.resources = { memoryBytes: 1024, cpus: 0.5, timeoutMs: 0 };
    await expect(b.prepare(opts)).rejects.toThrow(/timeout|resource/i);
  });

  it('calls collaborators in the mandatory order', async () => {
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
    // Launcher is invoked by the backend during prepare(); the mock records
    // the call and returns a handle that matches the just-returned carrier.
    const proxy = fakeProxyHandle(carrier);
    (deps.proxyLauncher.launch as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('proxyLauncher.launch');
      return proxy;
    });
    const opts = validPrepareOpts(carrier, proxy);
    await b.prepare(opts);

    expect(callOrder).toEqual([
      'probe',
      'setupNetns',
      'proxyLauncher.launch',
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
    const proxy = fakeProxyHandle(carrier);
    const opts = validPrepareOpts(carrier, proxy);
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
    const proxy = fakeProxyHandle(carrier);
    const opts = validPrepareOpts(carrier, proxy);
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
    const proxy = fakeProxyHandle(carrier);
    await b.prepare(validPrepareOpts(carrier, proxy));
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
    const proxy = fakeProxyHandle(carrier);
    await b.prepare(validPrepareOpts(carrier, proxy));

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

describe('OsSandboxBackend persistent process', () => {
  it('one PID can serve two newline-delimited requests; close() is idempotent', async () => {
    const deps = makeDeps();
    const fakeChild = makeFakeChild({ pid: 4242 });
    deps.spawnHelper.mockReturnValue(fakeChild);
    const b = new OsSandboxBackend({ sessionId: 'persist-1', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    const proxy = fakeProxyHandle(carrier);
    await b.prepare(validPrepareOpts(carrier, proxy));

    const proc = await b.spawn({ command: ['/usr/bin/node', '/skill/invoke.js'] });
    // Two newline-delimited requests on the SAME child PID (no new spawn).
    proc.stdin.write(JSON.stringify({ id: 1 }) + '\n');
    proc.stdin.write(JSON.stringify({ id: 2 }) + '\n');
    expect(deps.spawnHelper).toHaveBeenCalledTimes(1);
    expect(fakeChild.stdin.write).toHaveBeenCalledTimes(2);

    // Simulate two responses on the same child.
    fakeChild.emitStdout(Buffer.from('{"id":1,"ok":true}\n'));
    fakeChild.emitStdout(Buffer.from('{"id":2,"ok":true}\n'));

    const result = await proc.exited;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"id":1');
    expect(result.stdout).toContain('"id":2');
    // Idempotent close().
    await proc.close();
    await proc.close();
  });

  it('timeout calls cgroup.kill exactly once and waits for empty', async () => {
    const deps = makeDeps();
    const cgroup = fakeCgroup();
    deps.createLimitedCgroup.mockResolvedValue(cgroup);
    // Child never closes on its own — close event fires only after a long delay.
    const fakeChild = makeFakeChild({ pid: 9001, closeDelayMs: 250 });
    deps.spawnHelper.mockReturnValue(fakeChild);

    const b = new OsSandboxBackend({ sessionId: 'to-1', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    const proxy = fakeProxyHandle(carrier);
    await b.prepare(validPrepareOpts(carrier, proxy));

    const result = await b.run({ command: ['/usr/bin/node'], timeoutMs: 30 });
    expect(result.timedOut).toBe(true);
    expect(cgroup.kill).toHaveBeenCalledTimes(1);
    expect(cgroup.waitEmpty).toHaveBeenCalled();
    // Isolation metadata stays 'full' — containment succeeded.
    expect(result.meta.isolationLevel).toBe('full');
  });

  it('combined stdout+stderr overflow calls cgroup.kill exactly once', async () => {
    const deps = makeDeps();
    const cgroup = fakeCgroup();
    deps.createLimitedCgroup.mockResolvedValue(cgroup);
    const fakeChild = makeFakeChild({ pid: 9002, closeDelayMs: 50 });
    deps.spawnHelper.mockReturnValue(fakeChild);

    const b = new OsSandboxBackend({ sessionId: 'ovf-1', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    const proxy = fakeProxyHandle(carrier);
    await b.prepare(validPrepareOpts(carrier, proxy));

    const proc = await b.spawn({
      command: ['/usr/bin/node'],
      outputMaxBytes: 64,
      timeoutMs: 5000,
    });
    // Overflow the combined cap from BOTH pipes.
    fakeChild.emitStdout(Buffer.alloc(50, 0x61));
    fakeChild.emitStderr(Buffer.alloc(50, 0x62));
    fakeChild.emitStdout(Buffer.alloc(50, 0x63));

    const result = await proc.exited;
    expect(result.stderr).toMatch(/output cap exceeded/);
    expect(cgroup.kill).toHaveBeenCalledTimes(1);
    expect(cgroup.waitEmpty).toHaveBeenCalled();
    expect(result.meta.isolationLevel).toBe('full');
  });

  it('cgroup write/read-back failure during prepare prevents spawn', async () => {
    const deps = makeDeps();
    deps.createLimitedCgroup.mockRejectedValue(new Error('memory.max read-back mismatch'));
    const b = new OsSandboxBackend({ sessionId: 'cgfail', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    const proxy = fakeProxyHandle(carrier);
    await expect(b.prepare(validPrepareOpts(carrier, proxy))).rejects.toThrow(/read-back/);
    // Cannot spawn after failed prepare.
    await expect(b.spawn({ command: ['/usr/bin/node'] })).rejects.toThrow(/before prepare/);
  });

  it('attach failure prevents SIGCONT (kill signal is SIGKILL, not SIGCONT)', async () => {
    const deps = makeDeps();
    const cgroup = fakeCgroup();
    (cgroup.attach as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('read-back missing pid'));
    deps.createLimitedCgroup.mockResolvedValue(cgroup);
    const fakeChild = makeFakeChild({ pid: 9003 });
    deps.spawnHelper.mockReturnValue(fakeChild);

    const b = new OsSandboxBackend({ sessionId: 'att-1', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    const proxy = fakeProxyHandle(carrier);
    await b.prepare(validPrepareOpts(carrier, proxy));
    await expect(b.spawn({ command: ['/usr/bin/node'] })).rejects.toThrow(/read-back/);
    // SIGCONT was never sent; only SIGKILL cleanup.
    const killSigs = (fakeChild.kill as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(killSigs).not.toContain('SIGCONT');
    expect(killSigs).toContain('SIGKILL');
  });
});

// ---------------------------------------------------------------------------
// cleanup() — idempotent, reverse order
// ---------------------------------------------------------------------------

describe('OsSandboxBackend.cleanup', () => {
  it('is idempotent after full prepare+spawn', async () => {
    const deps = makeDeps();
    const b = new OsSandboxBackend({ sessionId: 'clean-1', deps: deps as unknown as OsBackendDeps });
    await b.probe();
    const carrier = await b.prepareTopology() as Extract<ProxyCarrier, { kind: 'linux-static' }>;
    const proxy = fakeProxyHandle(carrier);
    await b.prepare(validPrepareOpts(carrier, proxy));
    await b.cleanup();
    await b.cleanup();
  });
});
