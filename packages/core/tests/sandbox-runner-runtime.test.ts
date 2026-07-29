/**
 * SandboxRunner runtime-profile resolution + cleanup-order tests.
 *
 * - requested bins resolve to ONE trusted digest-pinned runtime profile.
 * - empty bins select a sane default trusted profile.
 * - when NO single trusted profile covers all requested bins, the runner
 *   returns UNSUPPORTED_RUNTIME_REQUIREMENTS BEFORE any backend prepare
 *   (and never invokes an installer).
 * - cleanup order matches Task 2 for success / timeout / prepare failure /
 *   spawn failure.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { SandboxConfig } from '@agentoctopus/sandbox';
import { SNAPSHOT_DIGEST_RE } from '@agentoctopus/sandbox';
import { SANDBOX_ERROR, SandboxRunner } from '../src/sandbox-runner.js';
import {
  RecordingBackend,
  RecordingProxyLauncher,
  RecordingSecretProvider,
  makeEventLog,
  makeSkillFixture,
  makeSnapshotStore,
  makeTrustedConfig,
  eventNames,
} from './sandbox-runner.test.js';

describe('SandboxRunner — runtime profiles', () => {
  let storeDir: string;
  let config: SandboxConfig;

  beforeEach(() => {
    storeDir = makeSnapshotStore();
    config = makeTrustedConfig();
  });

  it('resolves requested bins to ONE trusted runtime profile whose bins cover all of them', async () => {
    const { record } = makeEventLog();
    const backend = new RecordingBackend('docker', 'full', record);
    const runner = new SandboxRunner({
      config,
      snapshotStoreDir: storeDir,
      backends: [backend],
      proxyLauncher: new RecordingProxyLauncher(record),
      secretProvider: new RecordingSecretProvider(),
      installationIdFor: () => 'inst-1',
      onEvent: record,
    });
    const { skill } = makeSkillFixture({ sandboxBlock: { bins: ['node'] } });
    await runner.run({ skill, command: ['node', '/skill/scripts/invoke.js'] });
    expect(backend.prepareOptions?.runtimeProfile.id).toBe('node');
    expect(backend.prepareOptions?.runtimeProfile.bins).toContain('node');
    expect(backend.prepareOptions?.runtimeProfile.path).toBe('/usr/local/bin:/usr/bin:/bin');
    expect(backend.prepareOptions?.runtimeProfile.dockerImage).toMatch(/^node@sha256:/);
  });

  it('uses a deterministic default trusted profile when the skill requests no bins', async () => {
    const { record } = makeEventLog();
    const backend = new RecordingBackend('docker', 'full', record);
    // Use a config where the keys are NOT in the same order as makeTrustedConfig
    // so the test is not accidentally coupled to insertion order.
    const reorderedConfig = makeTrustedConfig();
    reorderedConfig.runtimeProfiles = {
      zebra: reorderedConfig.runtimeProfiles.bare!,
      alpha: reorderedConfig.runtimeProfiles.node!,
    };
    const runner = new SandboxRunner({
      config: reorderedConfig,
      snapshotStoreDir: storeDir,
      backends: [backend],
      proxyLauncher: new RecordingProxyLauncher(record),
      secretProvider: new RecordingSecretProvider(),
      installationIdFor: () => 'inst-1',
      onEvent: record,
    });
    const { skill } = makeSkillFixture(); // no bins
    await runner.run({ skill, command: ['node', '/skill/scripts/invoke.js'] });
    // Empty-bins skills still need a profile object to satisfy the required field.
    // The runner picks the lexicographically-first trusted profile key.
    expect(backend.prepareOptions?.runtimeProfile.id).toBe('alpha');
  });

  it('returns UNSUPPORTED_RUNTIME_REQUIREMENTS when NO single trusted profile covers all requested bins', async () => {
    const { log, record } = makeEventLog();
    const backend = new RecordingBackend('docker', 'full', record);
    const runner = new SandboxRunner({
      config,
      snapshotStoreDir: storeDir,
      backends: [backend],
      proxyLauncher: new RecordingProxyLauncher(record),
      secretProvider: new RecordingSecretProvider(),
      installationIdFor: () => 'inst-1',
      onEvent: record,
    });
    const { skill } = makeSkillFixture({ sandboxBlock: { bins: ['node', 'ffmpeg'] } });
    const result = await runner.run({ skill, command: ['node', '/skill/scripts/invoke.js'] });
    expect(result.success).toBe(false);
    expect(result.error).toContain('UNSUPPORTED_RUNTIME_REQUIREMENTS');
    // no backend prepare / no proxy launch / no run
    expect(eventNames(log)).not.toContain('backend.prepare:docker');
    expect(eventNames(log)).not.toContain('proxy.launch');
    expect(eventNames(log)).not.toContain('backend.run:docker');
  });

  it('runtime profile resolution happens BEFORE any backend prepareTopology call', async () => {
    const { log, record } = makeEventLog();
    const backend = new RecordingBackend('docker', 'full', record);
    const runner = new SandboxRunner({
      config,
      snapshotStoreDir: storeDir,
      backends: [backend],
      proxyLauncher: new RecordingProxyLauncher(record),
      secretProvider: new RecordingSecretProvider(),
      installationIdFor: () => 'inst-1',
      onEvent: record,
    });
    const { skill } = makeSkillFixture({ sandboxBlock: { bins: ['ffmpeg'] } });
    const result = await runner.run({ skill, command: ['node', '/skill/scripts/invoke.js'] });
    expect(result.success).toBe(false);
    expect(result.error).toContain('UNSUPPORTED_RUNTIME_REQUIREMENTS');
    expect(eventNames(log)).not.toContain('backend.prepareTopology:docker');
  });
});

describe('SandboxRunner — cleanup ordering', () => {
  let storeDir: string;
  let config: SandboxConfig;

  beforeEach(() => {
    storeDir = makeSnapshotStore();
    config = makeTrustedConfig();
  });

  it('cleans up in reverse order on success: process.close → backend.cleanup → proxy.close', async () => {
    const { log, record } = makeEventLog();
    const backend = new RecordingBackend('docker', 'full', record);
    const proxy = new RecordingProxyLauncher(record);
    const runner = new SandboxRunner({
      config,
      snapshotStoreDir: storeDir,
      backends: [backend],
      proxyLauncher: proxy,
      secretProvider: new RecordingSecretProvider(),
      installationIdFor: () => 'inst-1',
      onEvent: record,
    });
    const { skill } = makeSkillFixture();
    await runner.run({ skill, command: ['node', '/skill/scripts/invoke.js'] });
    const names = eventNames(log);
    const cleanupIdx = names.indexOf('backend.cleanup:docker');
    const proxyCloseIdx = names.indexOf('proxy.close');
    expect(cleanupIdx).toBeGreaterThanOrEqual(0);
    expect(proxyCloseIdx).toBeGreaterThan(cleanupIdx);
  });

  it('cleans up backend + proxy on spawn failure (reverse order)', async () => {
    const { log, record } = makeEventLog();
    const backend = new RecordingBackend('docker', 'full', record);
    backend.shouldFailSpawn = new Error('spawn boom');
    const proxy = new RecordingProxyLauncher(record);
    const runner = new SandboxRunner({
      config,
      snapshotStoreDir: storeDir,
      backends: [backend],
      proxyLauncher: proxy,
      secretProvider: new RecordingSecretProvider(),
      installationIdFor: () => 'inst-1',
      onEvent: record,
    });
    const { skill } = makeSkillFixture();
    await expect(
      runner.spawn({ skill, command: ['node', '/skill/scripts/invoke.js'] }),
    ).rejects.toThrow('spawn boom');
    const names = eventNames(log);
    const cleanupIdx = names.indexOf('backend.cleanup:docker');
    const proxyCloseIdx = names.indexOf('proxy.close');
    expect(cleanupIdx).toBeGreaterThanOrEqual(0);
    expect(proxyCloseIdx).toBeGreaterThan(cleanupIdx);
  });

  it('cleans up backend + proxy on run failure', async () => {
    const { log, record } = makeEventLog();
    const backend = new RecordingBackend('docker', 'full', record);
    backend.shouldFailRun = new Error('run boom');
    const proxy = new RecordingProxyLauncher(record);
    const runner = new SandboxRunner({
      config,
      snapshotStoreDir: storeDir,
      backends: [backend],
      proxyLauncher: proxy,
      secretProvider: new RecordingSecretProvider(),
      installationIdFor: () => 'inst-1',
      onEvent: record,
    });
    const { skill } = makeSkillFixture();
    const result = await runner.run({ skill, command: ['node', '/skill/scripts/invoke.js'] });
    expect(result.success).toBe(false);
    const names = eventNames(log);
    expect(names).toContain('backend.cleanup:docker');
    expect(names).toContain('proxy.close');
  });

  it('cleans up backend + proxy on timeout (timedOut result)', async () => {
    const { log, record } = makeEventLog();
    const backend = new RecordingBackend('docker', 'full', record);
    backend.runResult = {
      exitCode: 137,
      stdout: '',
      stderr: 'timed out',
      timedOut: true,
      meta: { isolationLevel: 'full', backend: 'docker', degraded: false, degradationReasons: [] },
    };
    const proxy = new RecordingProxyLauncher(record);
    const runner = new SandboxRunner({
      config,
      snapshotStoreDir: storeDir,
      backends: [backend],
      proxyLauncher: proxy,
      secretProvider: new RecordingSecretProvider(),
      installationIdFor: () => 'inst-1',
      onEvent: record,
    });
    const { skill } = makeSkillFixture();
    const result = await runner.run({ skill, command: ['node', '/skill/scripts/invoke.js'] });
    expect(result.success).toBe(false);
    const names = eventNames(log);
    expect(names).toContain('backend.cleanup:docker');
    expect(names).toContain('proxy.close');
  });

  it('spawn() returns a SandboxSession whose close() runs process.close → backend.cleanup → proxy.close', async () => {
    const { log, record } = makeEventLog();
    const backend = new RecordingBackend('docker', 'full', record);
    const proxy = new RecordingProxyLauncher(record);
    const runner = new SandboxRunner({
      config,
      snapshotStoreDir: storeDir,
      backends: [backend],
      proxyLauncher: proxy,
      secretProvider: new RecordingSecretProvider(),
      installationIdFor: () => 'inst-1',
      onEvent: record,
    });
    const { skill } = makeSkillFixture();
    const session = await runner.spawn({ skill, command: ['node', '/skill/scripts/invoke.js'] });
    expect(session.backend).toBe('docker');
    expect(session.isolationLevel).toBe('full');
    await session.close();
    const names = eventNames(log);
    const pCloseIdx = names.indexOf('process.close:docker');
    const bCleanIdx = names.indexOf('backend.cleanup:docker');
    const proxyIdx = names.indexOf('proxy.close');
    expect(pCloseIdx).toBeGreaterThanOrEqual(0);
    expect(bCleanIdx).toBeGreaterThan(pCloseIdx);
    expect(proxyIdx).toBeGreaterThan(bCleanIdx);
  });
});

// ---------------------------------------------------------------------------
// T4 — expectedSnapshotDigest plumbing + runtime/backend fail-fast.
// ---------------------------------------------------------------------------

const VALID_DIGEST = `sha256:${'d'.repeat(64)}`;

function darwinOnlyConfig(): SandboxConfig {
  const cfg = makeTrustedConfig();
  cfg.runtimeProfiles = {
    darwinNode: {
      bins: ['node'],
      path: '/usr/local/bin',
      darwinRuntime: { manifestPath: '/runtime/darwin-node22.manifest.json' },
    },
  };
  return cfg;
}

function linuxOnlyConfig(): SandboxConfig {
  const cfg = makeTrustedConfig();
  cfg.runtimeProfiles = {
    linuxNode: {
      bins: ['node'],
      path: '/usr/bin',
      osRuntime: {
        artifactPath: '/runtime/linux-node22.rootfs.tar.zst',
        manifestPath: '/runtime/linux-node22.manifest.json',
        nodePath: '/usr/bin/node',
      },
    },
  };
  return cfg;
}

function mixedConfig(): SandboxConfig {
  const cfg = makeTrustedConfig();
  cfg.runtimeProfiles = {
    mixed: {
      bins: ['node'],
      path: '/usr/bin',
      dockerImage:
        'node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      osRuntime: {
        artifactPath: '/runtime/linux-node22.rootfs.tar.zst',
        manifestPath: '/runtime/linux-node22.manifest.json',
        nodePath: '/usr/bin/node',
      },
      darwinRuntime: { manifestPath: '/runtime/darwin-node22.manifest.json' },
    },
  };
  return cfg;
}

describe('SandboxRunner — expectedSnapshotDigest plumbing (T4)', () => {
  let storeDir: string;

  beforeEach(() => {
    storeDir = makeSnapshotStore();
  });

  it('every backend prepare call receives prepareOpts.expectedSnapshotDigest === identity.digest', async () => {
    const { record } = makeEventLog();
    const backend = new RecordingBackend('docker', 'full', record);
    const runner = new SandboxRunner({
      config: makeTrustedConfig(),
      snapshotStoreDir: storeDir,
      backends: [backend],
      proxyLauncher: new RecordingProxyLauncher(record),
      secretProvider: new RecordingSecretProvider(),
      installationIdFor: () => 'inst-1',
      onEvent: record,
    });
    const { skill } = makeSkillFixture({ sandboxBlock: { bins: ['node'] } });
    await runner.run({ skill, command: ['node', '/skill/scripts/invoke.js'] });
    const digest = backend.prepareOptions?.expectedSnapshotDigest;
    expect(typeof digest).toBe('string');
    expect(digest).toMatch(SNAPSHOT_DIGEST_RE);
    // The runner must hand the backend the SAME digest it built/verified.
    expect(backend.prepareOptions?.snapshotRoot).toContain(digest!.slice('sha256:'.length));
  });

  it('SNAPSHOT_DIGEST_RE matches sha256:<64 lowercase hex> only', () => {
    expect(VALID_DIGEST).toMatch(SNAPSHOT_DIGEST_RE);
    expect('sha256:' + 'A'.repeat(64)).not.toMatch(SNAPSHOT_DIGEST_RE); // uppercase
    expect('sha256:' + 'd'.repeat(63)).not.toMatch(SNAPSHOT_DIGEST_RE); // too short
    expect('sha256:' + 'd'.repeat(65)).not.toMatch(SNAPSHOT_DIGEST_RE); // too long
    expect('d'.repeat(64)).not.toMatch(SNAPSHOT_DIGEST_RE); // missing prefix
    expect('sha512:' + 'd'.repeat(64)).not.toMatch(SNAPSHOT_DIGEST_RE); // wrong algo
  });
});

describe('SandboxRunner — runtime/backend fail-fast (T4)', () => {
  let storeDir: string;

  beforeEach(() => {
    storeDir = makeSnapshotStore();
  });

  function makeRunner(opts: {
    config: SandboxConfig;
    backend: RecordingBackend;
    record: (name: string, detail?: unknown) => void;
  }): { runner: SandboxRunner; launcher: RecordingProxyLauncher } {
    const launcher = new RecordingProxyLauncher(opts.record);
    const runner = new SandboxRunner({
      config: opts.config,
      snapshotStoreDir: storeDir,
      backends: [opts.backend],
      proxyLauncher: launcher,
      secretProvider: new RecordingSecretProvider(),
      installationIdFor: () => 'inst-1',
      onEvent: opts.record,
    });
    return { runner, launcher };
  }

  it('Darwin-only profile + docker-selected backend rejects RUNTIME_BACKEND_MISMATCH with ZERO launcher.launch calls', async () => {
    const { log, record } = makeEventLog();
    const backend = new RecordingBackend('docker', 'full', record);
    const { runner, launcher } = makeRunner({ config: darwinOnlyConfig(), backend, record });
    const launchSpy = launcher.launch.bind(launcher);
    let launches = 0;
    launcher.launch = async (o, c) => { launches++; return launchSpy(o, c); };

    const { skill } = makeSkillFixture({ sandboxBlock: { bins: ['node'] } });
    const result = await runner.run({ skill, command: ['node', '/skill/scripts/invoke.js'] });
    expect(result.success).toBe(false);
    expect(result.error).toContain(SANDBOX_ERROR.RUNTIME_BACKEND_MISMATCH);
    expect(launches).toBe(0);
    // No topology either — fail-fast happens right after selection.
    expect(eventNames(log)).not.toContain('backend.prepareTopology:docker');
    expect(eventNames(log)).not.toContain('backend.prepare:docker');
  });

  it('Linux-only (osRuntime) profile + docker-selected backend rejects RUNTIME_BACKEND_MISMATCH with ZERO launches', async () => {
    const { log, record } = makeEventLog();
    const backend = new RecordingBackend('docker', 'full', record);
    const { runner, launcher } = makeRunner({ config: linuxOnlyConfig(), backend, record });
    let launches = 0;
    const orig = launcher.launch.bind(launcher);
    launcher.launch = async (o, c) => { launches++; return orig(o, c); };

    const { skill } = makeSkillFixture({ sandboxBlock: { bins: ['node'] } });
    const result = await runner.run({ skill, command: ['node', '/skill/scripts/invoke.js'] });
    expect(result.success).toBe(false);
    expect(result.error).toContain(SANDBOX_ERROR.RUNTIME_BACKEND_MISMATCH);
    expect(launches).toBe(0);
    expect(eventNames(log)).not.toContain('backend.prepareTopology:docker');
  });

  it('Docker-only profile + full os backend rejects RUNTIME_BACKEND_MISMATCH with ZERO launches', async () => {
    const { log, record } = makeEventLog();
    const backend = new RecordingBackend('os', 'full', record);
    // default docker-only trusted profile (makeTrustedConfig) — dockerImage only.
    const { runner, launcher } = makeRunner({ config: makeTrustedConfig(), backend, record });
    let launches = 0;
    const orig = launcher.launch.bind(launcher);
    launcher.launch = async (o, c) => { launches++; return orig(o, c); };

    const { skill } = makeSkillFixture({ sandboxBlock: { bins: ['node'] } });
    const result = await runner.run({ skill, command: ['node', '/skill/scripts/invoke.js'] });
    expect(result.success).toBe(false);
    expect(result.error).toContain(SANDBOX_ERROR.RUNTIME_BACKEND_MISMATCH);
    expect(launches).toBe(0);
    expect(eventNames(log)).not.toContain('backend.prepareTopology:os');
  });

  it('Linux-only profile + Darwin-restricted os backend rejects RUNTIME_BACKEND_MISMATCH with ZERO launches', async () => {
    const { log, record } = makeEventLog();
    const backend = new RecordingBackend('os', 'restricted', record);
    const config = linuxOnlyConfig();
    config.defaultBackend = 'os';
    config.minIsolationLevel = 'restricted';
    const { runner, launcher } = makeRunner({ config, backend, record });
    let launches = 0;
    const orig = launcher.launch.bind(launcher);
    launcher.launch = async (o, c) => { launches++; return orig(o, c); };

    const { skill } = makeSkillFixture({ sandboxBlock: { bins: ['node'] } });
    const result = await runner.run({ skill, command: ['node', '/skill/scripts/invoke.js'] });
    expect(result.success).toBe(false);
    expect(result.error).toContain(SANDBOX_ERROR.RUNTIME_BACKEND_MISMATCH);
    expect(launches).toBe(0);
    expect(eventNames(log)).not.toContain('backend.prepareTopology:os');
  });

  it('mixed profile proceeds for docker AND for full os AND for Darwin-restricted os', async () => {
    for (const probe of [
      { kind: 'docker' as const, level: 'full' as const },
      { kind: 'os' as const, level: 'full' as const },
      { kind: 'os' as const, level: 'restricted' as const },
    ]) {
      const { record } = makeEventLog();
      const backend = new RecordingBackend(probe.kind, probe.level, record);
      const config = mixedConfig();
      if (probe.kind === 'os' && probe.level === 'restricted') {
        config.defaultBackend = 'os';
        config.minIsolationLevel = 'restricted';
      }
      const { runner } = makeRunner({ config, backend, record });
      const { skill } = makeSkillFixture({ sandboxBlock: { bins: ['node'] } });
      const result = await runner.run({ skill, command: ['node', '/skill/scripts/invoke.js'] });
      expect(result.error ?? '').not.toContain(SANDBOX_ERROR.RUNTIME_BACKEND_MISMATCH);
      expect(backend.prepareOptions).toBeDefined();
      expect(backend.prepareOptions?.expectedSnapshotDigest).toMatch(SNAPSHOT_DIGEST_RE);
    }
  });

  it('resolveRuntimeProfile passes darwinRuntime through to ResolvedRuntimeProfile', async () => {
    const { record } = makeEventLog();
    const backend = new RecordingBackend('os', 'restricted', record);
    const config = darwinOnlyConfig();
    config.defaultBackend = 'os';
    config.minIsolationLevel = 'restricted';
    const { runner } = makeRunner({ config, backend, record });
    const { skill } = makeSkillFixture({ sandboxBlock: { bins: ['node'] } });
    await runner.run({ skill, command: ['node', '/skill/scripts/invoke.js'] });
    expect(backend.prepareOptions?.runtimeProfile.darwinRuntime?.manifestPath).toBe(
      '/runtime/darwin-node22.manifest.json',
    );
  });
});
