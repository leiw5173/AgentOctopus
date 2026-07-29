import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import {
  selectBackend,
  NoFullBackendError,
  type SandboxBackend,
  type SandboxProcess,
  type BackendRunResult,
  type ProxyCarrier,
  type BackendPrepareOptions,
} from '../src/backend.js';
import { SandboxConfigSchema } from '../src/schema.js';
import type { BackendKind, IsolationLevel } from '../src/types.js';
import { OsSandboxBackend, type OsBackendDeps } from '../src/os/os-backend.js';
import type { OsCaps } from '../src/os/probe.js';

const fake = (kind: any, level: any, ok: boolean): SandboxBackend => ({
  kind, isolationLevel: level,
  probe: async () => ok,
  prepareTopology: async () => ({ kind: 'in-process', listenHost: '127.0.0.1', reachableHost: '127.0.0.1' }),
  prepare: async () => {},
  spawn: async () => {
    const result = Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false,
      meta: { isolationLevel: level, backend: kind, degraded: false, degradationReasons: [] } });
    return {
      stdin: new (await import('node:stream')).PassThrough(),
      stdout: new (await import('node:stream')).PassThrough(),
      stderr: new (await import('node:stream')).PassThrough(),
      exited: result,
      kill: async () => {},
      close: async () => {},
    };
  },
  run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false,
    meta: { isolationLevel: level, backend: kind, degraded: false, degradationReasons: [] } }),
  cleanup: async () => {},
});

describe('selectBackend (fail-closed)', () => {
  const cfg = SandboxConfigSchema.parse({ defaultBackend: 'auto', minIsolationLevel: 'full' });

  it('picks a full backend that passes probe', async () => {
    const b = await selectBackend(cfg, [fake('docker', 'full', true)]);
    expect(b.kind).toBe('docker');
  });

  it('refuses when no backend meets minIsolationLevel (fail-closed)', async () => {
    await expect(selectBackend(cfg, [fake('subprocess', 'restricted', true)]))
      .rejects.toBeInstanceOf(NoFullBackendError);
  });

  it('refuses when the only full backend fails probe', async () => {
    await expect(selectBackend(cfg, [fake('docker', 'full', false), fake('os', 'full', false)]))
      .rejects.toBeInstanceOf(NoFullBackendError);
  });

  it('does not auto-select a restricted backend even if available', async () => {
    await expect(selectBackend(cfg, [fake('subprocess', 'restricted', true), fake('ssh', 'remote-unverified', true)]))
      .rejects.toBeInstanceOf(NoFullBackendError);
  });
});

// ---------------------------------------------------------------------------
// Plan 7 Task 1 — probe-before-rank regression.
// A backend that starts at `restricted` but probes to `full` must be selected
// for `auto/full`. The old code ranked BEFORE probing, dropping such a backend.
// ---------------------------------------------------------------------------

/**
 * A backend whose `isolationLevel` mutates on probe: it starts `restricted`
 * but reaches `full` once `probe()` succeeds (mirrors the real OS backend,
 * which starts `restricted` and promotes to `full` only after a live capability
 * probe). If `probeOk` is false the level stays `restricted`.
 */
class ProbeGatedBackend implements SandboxBackend {
  kind: BackendKind;
  isolationLevel: IsolationLevel;
  private readonly probeOk: boolean;
  probed = false;

  constructor(kind: BackendKind, probeOk: boolean) {
    this.kind = kind;
    this.isolationLevel = 'restricted';
    this.probeOk = probeOk;
  }

  async probe(): Promise<boolean> {
    this.probed = true;
    if (this.probeOk) this.isolationLevel = 'full';
    return this.probeOk;
  }
  prepareTopology = async () => ({ kind: 'in-process', listenHost: '127.0.0.1', reachableHost: '127.0.0.1' }) as ProxyCarrier;
  prepare = async () => {};
  spawn = async () => {
    const { PassThrough } = await import('node:stream');
    return {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exited: Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false,
        meta: { isolationLevel: this.isolationLevel, backend: this.kind, degraded: false, degradationReasons: [] } }),
      kill: async () => {},
      close: async () => {},
    };
  };
  run = async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false,
    meta: { isolationLevel: this.isolationLevel, backend: this.kind, degraded: false, degradationReasons: [] } });
  cleanup = async () => {};
}

describe('selectBackend (probe-before-rank)', () => {
  const cfg = SandboxConfigSchema.parse({ defaultBackend: 'auto', minIsolationLevel: 'full' });

  it('probes a restricted-start backend and selects it once it reaches full', async () => {
    const b = new ProbeGatedBackend('os', true);
    const chosen = await selectBackend(cfg, [b]);
    expect(b.probed).toBe(true);
    expect(chosen).toBe(b);
    expect(chosen.isolationLevel).toBe('full');
  });

  it('fails closed when the probe does not promote to full', async () => {
    const b = new ProbeGatedBackend('os', false);
    await expect(selectBackend(cfg, [b])).rejects.toBeInstanceOf(NoFullBackendError);
    expect(b.probed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T1 — selection semantics: probe-before-rank against the REAL OS backend +
// exact restricted-OS opt-in guard.
//
// The Linux full case exercises the production OsSandboxBackend via DI seams
// (probeOsCaps + resolveOsArtifacts) so the full promotion path
// (restricted → full on Linux caps) is covered without touching a kernel.
//
// The Darwin-restricted opt-in cases use a minimal `SandboxBackend` stub that
// models the post-T10 Darwin behavior: probe() === true with a stable
// `restricted` isolationLevel. The current OsSandboxBackend's probe returns
// false on non-Linux (the platform dispatch seam lands in T10, and the
// behavioral Darwin probe lands in T7), so the real class cannot yet reach
// the selectable-restricted state T1 guards. Using a stub here keeps T1
// scoped to selection semantics, which is the only behavior T1 changes.
// ---------------------------------------------------------------------------

function fullLinuxCaps(): OsCaps {
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

const ARTIFACT_FIXTURE = {
  runtimeArtifactPath: '/runtime/linux-node22.rootfs.tar.zst',
  runtimeManifestPath: '/runtime/linux-node22.manifest.json',
  helperManifestPath: '/runtime/os-helper.manifest.json',
  helperBinaryPath: '/runtime/os-helper',
  proxyBundlePath: '/build/egress-proxy-server.mjs',
  proxyBundleManifestPath: '/build/egress-proxy-server.mjs.manifest.json',
};

function fullLinuxDeps(): OsBackendDeps {
  return {
    probeOsCaps: vi.fn(async () => fullLinuxCaps()),
    resolveOsArtifacts: vi.fn(async () => ARTIFACT_FIXTURE),
  };
}

/**
 * Stub that models the post-T10 Darwin OS backend: probe succeeds, level is
 * pinned to `restricted`. Lets the T1 selection guard be exercised without
 * waiting for the platform dispatch + behavioral probe (T7/T10).
 */
class RestrictedOsBackend implements SandboxBackend {
  readonly kind = 'os' as const;
  readonly isolationLevel: IsolationLevel = 'restricted';
  async probe(): Promise<boolean> { return true; }
  prepareTopology = async () => ({ kind: 'in-process', listenHost: '127.0.0.1', reachableHost: '127.0.0.1' }) as ProxyCarrier;
  prepare = async () => {};
  spawn = async () => {
    const { PassThrough } = await import('node:stream');
    return {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      exited: Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false,
        meta: { isolationLevel: this.isolationLevel, backend: this.kind, degraded: false, degradationReasons: [] } }),
      kill: async () => {}, close: async () => {},
    };
  };
  run = async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false,
    meta: { isolationLevel: this.isolationLevel, backend: this.kind, degraded: false, degradationReasons: [] } });
  cleanup = async () => {};
}

function darwinBackend(): SandboxBackend {
  return new RestrictedOsBackend();
}

describe('selectBackend (T1 — restricted-OS opt-in + probe resilience)', () => {
  it('auto/full selects the real OS backend after it probes to full (Linux caps)', async () => {
    const b = new OsSandboxBackend({ sessionId: 'sel-full', deps: fullLinuxDeps() });
    expect(b.isolationLevel).toBe('restricted'); // pre-probe state
    const cfg = SandboxConfigSchema.parse({ defaultBackend: 'auto', minIsolationLevel: 'full' });
    expect(await selectBackend(cfg, [b])).toBe(b);
  });

  it('auto/full rejects a Darwin OS backend that stays restricted', async () => {
    const cfg = SandboxConfigSchema.parse({ defaultBackend: 'auto', minIsolationLevel: 'full' });
    await expect(selectBackend(cfg, [darwinBackend()])).rejects.toBeInstanceOf(NoFullBackendError);
  });

  it('auto/restricted never implicitly selects restricted OS', async () => {
    const cfg = SandboxConfigSchema.parse({ defaultBackend: 'auto', minIsolationLevel: 'restricted' });
    await expect(selectBackend(cfg, [darwinBackend()])).rejects.toBeInstanceOf(NoFullBackendError);
  });

  it('os/full and os/none both reject restricted OS', async () => {
    for (const min of ['full', 'none'] as const) {
      const cfg = SandboxConfigSchema.parse({ defaultBackend: 'os', minIsolationLevel: min });
      await expect(selectBackend(cfg, [darwinBackend()])).rejects.toBeInstanceOf(NoFullBackendError);
    }
  });

  it('exact os/restricted selects the restricted OS backend', async () => {
    const cfg = SandboxConfigSchema.parse({ defaultBackend: 'os', minIsolationLevel: 'restricted' });
    expect((await selectBackend(cfg, [darwinBackend()])).isolationLevel).toBe('restricted');
  });

  it('probe throw excludes the candidate; strongest post-probe level wins', async () => {
    const throwing: SandboxBackend = {
      kind: 'docker',
      isolationLevel: 'full',
      probe: async () => { throw new Error('probe blew up'); },
      prepareTopology: async () => ({ kind: 'in-process', listenHost: '127.0.0.1', reachableHost: '127.0.0.1' }),
      prepare: async () => {},
      spawn: async () => {
        const { PassThrough } = await import('node:stream');
        return {
          stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
          exited: Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false,
            meta: { isolationLevel: 'full', backend: 'docker', degraded: false, degradationReasons: [] } }),
          kill: async () => {}, close: async () => {},
        };
      },
      run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false,
        meta: { isolationLevel: 'full', backend: 'docker', degraded: false, degradationReasons: [] } }),
      cleanup: async () => {},
    };
    const full = new ProbeGatedBackend('os', true); // probes to 'full'
    const cfg = SandboxConfigSchema.parse({ defaultBackend: 'auto', minIsolationLevel: 'full' });
    const chosen = await selectBackend(cfg, [throwing, full]);
    expect(chosen).toBe(full);
    expect(chosen.isolationLevel).toBe('full');
  });
});

// ---------------------------------------------------------------------------
// Plan 5, Task 2 — type-level contract assertions + ProxyCarrier shape.
// ---------------------------------------------------------------------------

describe('SandboxBackend type-level contract', () => {
  it('spawn is a function returning a SandboxProcess promise', () => {
    expectTypeOf<SandboxBackend['spawn']>().toBeFunction();
    expectTypeOf<SandboxBackend['prepareTopology']>().toBeFunction();
    expectTypeOf<SandboxBackend['prepare']>().toBeFunction();
    expectTypeOf<SandboxBackend['run']>().toBeFunction();
    expectTypeOf<SandboxBackend['cleanup']>().toBeFunction();
    expectTypeOf<SandboxBackend['probe']>().toBeFunction();
  });

  it('SandboxProcess.stdin is a NodeJS.WritableStream; exited is the sole completion promise', () => {
    expectTypeOf<SandboxProcess['stdin']>().toMatchTypeOf<NodeJS.WritableStream>();
    expectTypeOf<SandboxProcess['stdout']>().toMatchTypeOf<NodeJS.ReadableStream>();
    expectTypeOf<SandboxProcess['stderr']>().toMatchTypeOf<NodeJS.ReadableStream>();
    expectTypeOf<SandboxProcess['exited']>().toMatchTypeOf<Promise<BackendRunResult>>();
    // There is no wait() method on the canonical contract.
    expectTypeOf<SandboxProcess>().not.toHaveProperty('wait');
  });

  it('BackendPrepareOptions carries the literal canonical guest paths', () => {
    expectTypeOf<BackendPrepareOptions['guestSkillRoot']>().toEqualTypeOf<'/skill'>();
    expectTypeOf<BackendPrepareOptions['guestCaBundlePath']>().toEqualTypeOf<'/etc/skill-ca/ca.pem'>();
    expectTypeOf<BackendPrepareOptions['proxyAddr']>().toBeString();
    expectTypeOf<BackendPrepareOptions['caBundlePath']>().toBeString();
  });
});

describe('prepareTopology returns a ProxyCarrier (canonical union)', () => {
  it('in-process carrier has listenHost/reachableHost', async () => {
    const b = fake('docker', 'full', true);
    const carrier = await b.prepareTopology();
    expect(carrier.kind).toBe('in-process');
    if (carrier.kind === 'in-process') {
      expect(carrier.listenHost).toBeTruthy();
      expect(carrier.reachableHost).toBeTruthy();
    }
  });

  it('docker-sidecar carrier shape: internal+egress networks and reachableHost (never loopback)', () => {
    const carrier: ProxyCarrier = {
      kind: 'docker-sidecar',
      proxyImage: 'example/proxy@sha256:' + 'a'.repeat(64),
      internalNetwork: 'octopus-sbx-x-internal',
      egressNetwork: 'octopus-sbx-x-egress',
      reachableHost: 'egress-proxy',
    };
    expect(carrier.kind).toBe('docker-sidecar');
    if (carrier.kind === 'docker-sidecar') {
      expect(carrier.internalNetwork).toMatch(/-internal$/);
      expect(carrier.egressNetwork).toMatch(/-egress$/);
      expect(carrier.reachableHost).not.toMatch(/127\.0\.0\.1|localhost/);
    }
  });

  it('linux-static carrier shape: listenHost/reachableHost are the veth peer (never loopback)', () => {
    const carrier: ProxyCarrier = {
      kind: 'linux-static',
      binaryPath: '/build/egress-proxy-server.mjs',
      skillNamespace: { name: 'octn-x', path: '/run/netns/octn-x' },
      listenHost: '169.254.7.1',
      reachableHost: '169.254.7.1',
      cgroupPath: '/sys/fs/cgroup/oct-proxy-x',
      listenPort: 43210,
    };
    expect(carrier.kind).toBe('linux-static');
    if (carrier.kind === 'linux-static') {
      expect(carrier.listenHost).not.toMatch(/127\.0\.0\.1|localhost/);
      expect(carrier.reachableHost).not.toMatch(/127\.0\.0\.1|localhost/);
      expect(carrier.listenPort).toBeGreaterThan(0);
      expect(carrier.cgroupPath).toMatch(/^\/sys\/fs\/cgroup\//);
    }
  });
});
