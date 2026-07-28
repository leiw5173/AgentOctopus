/**
 * OS backend persistent-process contract (Plan 5, Task 2).
 *
 * Verbatim move of the persistent-process block from os-backend.test.ts so
 * the file layout matches the brief: OS-specific persistent-process behavior
 * (duplex on one PID, cgroup-kill-once on timeout / output overflow, attach
 * failure blocks SIGCONT, cgroup read-back failure blocks spawn) lives here.
 *
 * The fixture builders and the makeFakeChild helper are copied verbatim from
 * os-backend.test.ts (which keeps its own copies for the remaining blocks —
 * those exercise different collaborators and must stay green independently).
 *
 * DI discipline: no vi.mock('node:child_process'). All effects go through
 * OsSandboxBackendOptions.deps.
 *
 * Proxy ownership: the orchestrator (SandboxRunner + DefaultProxyLauncher)
 * has ALREADY launched the proxy and supplies its coordinates via
 * prepareOpts.proxyAddr / caBundlePath. The backend validates those against
 * the carrier and authorizes nft — it must NOT launch or own a proxy itself.
 * Mirrors the supplied-coordinate fixture pattern from os-backend.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { OsSandboxBackend, type OsBackendDeps } from '../src/os/os-backend.js';
import type { OsCaps } from '../src/os/probe.js';
import type { RootfsLayout } from '../src/os/rootfs.js';
import type { CgroupHandle } from '../src/os/cgroup.js';
import type { NetnsHandle } from '../src/os/netns.js';
import type { ProxyCarrier, BackendPrepareOptions } from '../src/backend.js';

// ---------------------------------------------------------------------------
// Fixture builders (verbatim from os-backend.test.ts)
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
    stat: vi.fn(async () => ({ isDirectory: () => true })),
  };
}

// ---------------------------------------------------------------------------
// Persistent-process behavior + timeout/output-overflow containment
// (verbatim move from os-backend.test.ts)
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
    await b.prepare(validPrepareOpts(carrier));

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
    await b.prepare(validPrepareOpts(carrier));

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
    await b.prepare(validPrepareOpts(carrier));

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
    await expect(b.prepare(validPrepareOpts(carrier))).rejects.toThrow(/read-back/);
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
    await b.prepare(validPrepareOpts(carrier));
    await expect(b.spawn({ command: ['/usr/bin/node'] })).rejects.toThrow(/read-back/);
    // SIGCONT was never sent; only SIGKILL cleanup.
    const killSigs = (fakeChild.kill as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(killSigs).not.toContain('SIGCONT');
    expect(killSigs).toContain('SIGKILL');
  });
});
