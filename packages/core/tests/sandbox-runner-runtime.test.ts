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
import { SandboxRunner } from '../src/sandbox-runner.js';
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
