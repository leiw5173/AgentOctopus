import { describe, it, expect, expectTypeOf } from 'vitest';
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
