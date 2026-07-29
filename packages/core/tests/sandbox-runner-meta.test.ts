/**
 * SandboxRunner result-meta propagation tests (T3).
 *
 * Asserts:
 *   - run() output carries the backend's `result.meta` VERBATIM when cleanup
 *     is clean.
 *   - ContainmentCleanupError from backend.cleanup() DOWNGRADES the reported
 *     isolationLevel to 'none', marks degraded, appends containment reasons,
 *     and forces success=false.
 *   - Soft teardown failures (proxy close, session-dir removal) surface as
 *     degradation reasons WITHOUT downgrading isolation.
 *   - SandboxSession.resultMeta is PENDING before close() and definitive only
 *     post-close; containment failure on close() rethrows ContainmentCleanupError
 *     AND still resolves resultMeta with isolationLevel='none'.
 *   - Degradation reasons NEVER carry credential/grant material.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import type {
  BackendRunResult,
  ExecSpec,
  ProxyCarrier,
  ProxyHandle,
  ProxyLauncher,
  SandboxBackend,
  SandboxConfig,
  SandboxPolicy,
  SandboxProcess,
  SpawnSpec,
  ResolvedSecrets,
  BackendKind,
  IsolationLevel,
} from '@agentoctopus/sandbox';
import { ContainmentCleanupError } from '@agentoctopus/sandbox';
import { SandboxRunner } from '../src/sandbox-runner.js';
import {
  makeEventLog,
  RecordingSecretProvider,
  makeSkillFixture,
  makeSnapshotStore,
  makeTrustedConfig,
} from './sandbox-runner.test.js';

// ---------------------------------------------------------------------------
// T3 fakes (local — the shared harness is intentionally not extended)
// ---------------------------------------------------------------------------

const RESTRICTED_META = {
  isolationLevel: 'restricted' as const,
  backend: 'os' as const,
  degraded: true,
  degradationReasons: ['darwin-restricted-lane'],
};

class MetaBackend implements SandboxBackend {
  runResultMeta = RESTRICTED_META;
  cleanupError: ContainmentCleanupError | Error | undefined;
  cleanupCalls = 0;

  constructor(
    public readonly kind: BackendKind,
    public readonly isolationLevel: IsolationLevel,
  ) {}

  async probe(): Promise<boolean> { return true; }
  async prepareTopology(): Promise<ProxyCarrier> {
    return { kind: 'in-process', listenHost: '10.0.0.1', reachableHost: '10.0.0.1' };
  }
  async prepare(): Promise<void> {}
  async run(_spec: ExecSpec): Promise<BackendRunResult> {
    return {
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      timedOut: false,
      meta: this.runResultMeta,
    };
  }
  async spawn(_spec: SpawnSpec): Promise<SandboxProcess> {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const exited = Promise.resolve<BackendRunResult>({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      meta: this.runResultMeta,
    });
    return {
      stdin,
      stdout,
      stderr,
      exited,
      kill: async () => {},
      close: async () => {},
    };
  }
  async cleanup(): Promise<void> {
    this.cleanupCalls++;
    if (this.cleanupError) throw this.cleanupError;
  }
}

class MetaProxyLauncher implements ProxyLauncher {
  closeError: Error | undefined;
  reachableAddr = 'http://10.0.0.1:8888';
  caBundlePath = '/tmp/host-ca/ca.pem';
  async launch(
    _opts: { policy: SandboxPolicy; secrets: ResolvedSecrets; workDir: string },
    _carrier: ProxyCarrier,
  ): Promise<ProxyHandle> {
    const closeError = this.closeError;
    return {
      reachableAddr: this.reachableAddr,
      caBundlePath: this.caBundlePath,
      close: async () => {
        if (closeError) throw closeError;
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SandboxRunner — result meta propagation (T3)', () => {
  let storeDir: string;
  let config: SandboxConfig;

  beforeEach(() => {
    storeDir = makeSnapshotStore();
    config = makeTrustedConfig({
      // Permit the restricted OS lane: T3 tests use a restricted meta backend.
      defaultBackend: 'os',
      minIsolationLevel: 'restricted',
      runtimeProfiles: {
        darwin: {
          bins: [],
          path: '/usr/bin:/bin',
          darwinRuntime: { manifestPath: '/trusted/darwin-runtime.manifest.json' },
        },
      },
    });
  });

  function makeRunner(opts: {
    backend: MetaBackend;
    proxyLauncher?: MetaProxyLauncher;
    rmSessionDir?: (dir: string) => Promise<void>;
  }): SandboxRunner {
    return new SandboxRunner({
      config,
      snapshotStoreDir: storeDir,
      backends: [opts.backend],
      proxyLauncher: opts.proxyLauncher ?? new MetaProxyLauncher(),
      secretProvider: new RecordingSecretProvider(),
      installationIdFor: () => 'inst-1',
      rmSessionDir: opts.rmSessionDir,
    });
  }

  it('run() output carries result.meta verbatim when cleanup is clean', async () => {
    const backend = new MetaBackend('os', 'restricted');
    const runner = makeRunner({ backend });
    const { skill } = makeSkillFixture();
    const out = await runner.run({ skill, command: ['node', '/skill/x.js'] });
    expect(out.meta).toEqual({
      isolationLevel: 'restricted',
      backend: 'os',
      degraded: true,
      degradationReasons: ['darwin-restricted-lane'],
    });
    // Pass-through fields stay in sync with meta.
    expect(out.isolationLevel).toBe('restricted');
    expect(out.backend).toBe('os');
    expect(out.success).toBe(true);
  });

  it('downgrades run output to none when cleanup fails AFTER successful exited', async () => {
    const backend = new MetaBackend('os', 'restricted');
    backend.cleanupError = new ContainmentCleanupError(['group kill failed']);
    const runner = makeRunner({ backend });
    const { skill } = makeSkillFixture();
    const out = await runner.run({ skill, command: ['node', '/skill/x.js'] });
    expect(out.meta.isolationLevel).toBe('none');
    expect(out.meta.degraded).toBe(true);
    expect(out.meta.degradationReasons).toContain('group kill failed');
    // Backend-reported reasons are preserved (prepended).
    expect(out.meta.degradationReasons).toContain('darwin-restricted-lane');
    expect(out.success).toBe(false);
    expect(out.isolationLevel).toBe('none');
  });

  it('downgrades when cleanup throws a NON-ContainmentCleanupError (wrapped)', async () => {
    const backend = new MetaBackend('os', 'restricted');
    backend.cleanupError = new Error('netns delete refused');
    const runner = makeRunner({ backend });
    const { skill } = makeSkillFixture();
    const out = await runner.run({ skill, command: ['node', '/skill/x.js'] });
    expect(out.meta.isolationLevel).toBe('none');
    expect(out.meta.degraded).toBe(true);
    expect(out.meta.degradationReasons.join(' ')).toMatch(/netns delete refused/);
    expect(out.success).toBe(false);
  });

  it('session-dir removal failure is a degradation reason, NOT containment (level preserved)', async () => {
    const backend = new MetaBackend('os', 'restricted');
    const runner = makeRunner({
      backend,
      rmSessionDir: async () => {
        throw new Error('ENOTEMPTY: directory not empty');
      },
    });
    const { skill } = makeSkillFixture();
    const out = await runner.run({ skill, command: ['node', '/skill/x.js'] });
    expect(out.meta.isolationLevel).toBe('restricted');
    expect(out.meta.degraded).toBe(true);
    expect(out.meta.degradationReasons.join(' ')).toMatch(/session dir removal failed/);
    expect(out.success).toBe(true);
  });

  it('proxy close failure preserves level but marks degraded', async () => {
    const backend = new MetaBackend('os', 'restricted');
    const proxy = new MetaProxyLauncher();
    proxy.closeError = new Error('listener close timeout');
    const runner = makeRunner({ backend, proxyLauncher: proxy });
    const { skill } = makeSkillFixture();
    const out = await runner.run({ skill, command: ['node', '/skill/x.js'] });
    expect(out.meta.isolationLevel).toBe('restricted');
    expect(out.meta.degraded).toBe(true);
    expect(out.meta.degradationReasons.join(' ')).toMatch(/proxy close failed/);
    expect(out.success).toBe(true);
  });

  it('containment + soft: ALL reasons appear, level downgrades to none', async () => {
    const backend = new MetaBackend('os', 'restricted');
    backend.cleanupError = new ContainmentCleanupError(['cgroup.kill EIO']);
    const proxy = new MetaProxyLauncher();
    proxy.closeError = new Error('proxy race');
    const runner = makeRunner({
      backend,
      proxyLauncher: proxy,
      rmSessionDir: async () => {
        throw new Error('rm race');
      },
    });
    const { skill } = makeSkillFixture();
    const out = await runner.run({ skill, command: ['node', '/skill/x.js'] });
    expect(out.meta.isolationLevel).toBe('none');
    expect(out.meta.degraded).toBe(true);
    const reasons = out.meta.degradationReasons.join(' | ');
    expect(reasons).toMatch(/cgroup\.kill EIO/);
    expect(reasons).toMatch(/proxy close failed/);
    expect(reasons).toMatch(/session dir removal failed/);
    expect(out.success).toBe(false);
  });

  it('runError + containment: error field is the run error, meta still downgraded', async () => {
    class FailingRunBackend extends MetaBackend {
      override async run(): Promise<BackendRunResult> {
        throw new Error('exec exploded');
      }
    }
    const backend = new FailingRunBackend('os', 'restricted');
    backend.cleanupError = new ContainmentCleanupError(['cgroup kill failed']);
    const runner = makeRunner({ backend });
    const { skill } = makeSkillFixture();
    const out = await runner.run({ skill, command: ['node', '/skill/x.js'] });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/exec exploded/);
    expect(out.meta.isolationLevel).toBe('none');
    expect(out.meta.degradationReasons).toContain('cgroup kill failed');
  });

  it('never leaks secret substrings into degradationReasons', async () => {
    // A marker credential value is provisioned into the session; teardown
    // failures then occur. Assert the marker NEVER appears in any degradation
    // reason — only trusted teardown error messages and the fixed literal
    // prefixes are allowed.
    const SECRET_MARKER = 'marker-credential-9f2b4e7d-no-leak';
    const backend = new MetaBackend('os', 'restricted');
    backend.cleanupError = new ContainmentCleanupError(['cgroup.kill EIO']);
    const proxy = new MetaProxyLauncher();
    proxy.closeError = new Error('proxy tls close: EPIPE');
    const secretProvider = new RecordingSecretProvider();
    secretProvider.values.set('WTR_API_KEY', SECRET_MARKER);
    const runner = new SandboxRunner({
      config,
      snapshotStoreDir: storeDir,
      backends: [backend],
      proxyLauncher: proxy,
      secretProvider,
      installationIdFor: () => 'inst-1',
      rmSessionDir: async () => {
        throw new Error('rm race');
      },
    });
    const { skill } = makeSkillFixture();
    const out = await runner.run({ skill, command: ['node', '/skill/x.js'] });
    expect(out.meta.degraded).toBe(true);
    expect(out.meta.degradationReasons.length).toBeGreaterThan(0);
    for (const reason of out.meta.degradationReasons) {
      expect(reason).not.toContain(SECRET_MARKER);
    }
    // Defense-in-depth: the serialized output is also clean.
    expect(JSON.stringify(out)).not.toContain(SECRET_MARKER);
  });

  it('resultMeta is pending before close and none after close when cleanup fails', async () => {
    const backend = new MetaBackend('os', 'restricted');
    backend.cleanupError = new ContainmentCleanupError(['group kill failed']);
    const runner = makeRunner({ backend });
    const { skill } = makeSkillFixture();
    const s = await runner.spawn({ skill, command: ['node', '/skill/x.js'] });
    let settled = false;
    void s.resultMeta.then(() => {
      settled = true;
    });
    await s.process.exited;
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false); // definitive only post-close
    await expect(s.close()).rejects.toBeInstanceOf(ContainmentCleanupError);
    const meta = await s.resultMeta;
    expect(meta.isolationLevel).toBe('none');
    expect(meta.degraded).toBe(true);
    expect(meta.degradationReasons).toContain('group kill failed');
  });

  it('close() rethrows the SAME memoized ContainmentCleanupError on repeat', async () => {
    const backend = new MetaBackend('os', 'restricted');
    backend.cleanupError = new ContainmentCleanupError(['group kill failed']);
    const runner = makeRunner({ backend });
    const { skill } = makeSkillFixture();
    const s = await runner.spawn({ skill, command: ['node', '/skill/x.js'] });
    const first = await s.close().catch((e) => e);
    expect(first).toBeInstanceOf(ContainmentCleanupError);
    const second = await s.close().catch((e) => e);
    expect(second).toBe(first);
  });

  it('close() with only soft failures resolves resultMeta with level preserved', async () => {
    const backend = new MetaBackend('os', 'restricted');
    const proxy = new MetaProxyLauncher();
    proxy.closeError = new Error('proxy race');
    const runner = makeRunner({
      backend,
      proxyLauncher: proxy,
      rmSessionDir: async () => {
        throw new Error('rm race');
      },
    });
    const { skill } = makeSkillFixture();
    const s = await runner.spawn({ skill, command: ['node', '/skill/x.js'] });
    await s.close(); // must NOT throw — soft only
    const meta = await s.resultMeta;
    expect(meta.isolationLevel).toBe('restricted');
    expect(meta.degraded).toBe(true);
    expect(meta.degradationReasons.join(' ')).toMatch(/proxy close failed/);
    expect(meta.degradationReasons.join(' ')).toMatch(/session dir removal failed/);
  });
});
