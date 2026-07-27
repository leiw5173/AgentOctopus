/**
 * SandboxRunner proxy integration + env hygiene tests.
 *
 * - The proxy is launched with a non-loopback reachable address (the launcher
 *   + carrier own that); the runner forwards handle.reachableAddr into
 *   backend.prepare.
 * - A per-session CA bundle path is forwarded.
 * - Env hygiene: minimal allowlist + non-reserved caller keys + fixed guest
 *   HOME / TMPDIR / runtime-profile PATH. process.env never spreads.
 * - Payload is serialized exactly once to OCTOPUS_INPUT; stdin passes through.
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
} from './sandbox-runner.test.js';

describe('SandboxRunner — proxy integration', () => {
  let storeDir: string;
  let config: SandboxConfig;

  beforeEach(() => {
    storeDir = makeSnapshotStore();
    config = makeTrustedConfig();
  });

  it('forwards the launcher-provided non-loopback reachable address to backend.prepare', async () => {
    const { record } = makeEventLog();
    const backend = new RecordingBackend('docker', 'full', record);
    const proxy = new RecordingProxyLauncher(record);
    proxy.reachableAddr = 'http://10.99.88.77:9123';
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
    expect(backend.prepareOptions?.proxyAddr).toBe('http://10.99.88.77:9123');
    expect(backend.prepareOptions?.proxyAddr).not.toMatch(/127\.0\.0\.1|localhost/);
  });

  it('forwards the launcher-provided per-session CA bundle path to backend.prepare', async () => {
    const { record } = makeEventLog();
    const backend = new RecordingBackend('docker', 'full', record);
    const proxy = new RecordingProxyLauncher(record);
    proxy.caBundlePath = '/tmp/host-ca/session-XYZ.pem';
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
    expect(backend.prepareOptions?.caBundlePath).toBe('/tmp/host-ca/session-XYZ.pem');
  });

  it('runs proxy cleanup even when backend.prepare fails (cleanup is reverse + idempotent)', async () => {
    const { log, record } = makeEventLog();
    const backend = new RecordingBackend('docker', 'full', record);
    backend.shouldFailPrepare = new Error('boom');
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
    // Cleanup ordering: backend.cleanup must run, proxy.close must run.
    const names = log.map((e) => e.name);
    expect(names).toContain('backend.cleanup:docker');
    expect(names).toContain('proxy.close');
  });
});

describe('SandboxRunner — env hygiene and payload serialization', () => {
  let storeDir: string;
  let config: SandboxConfig;

  beforeEach(() => {
    storeDir = makeSnapshotStore();
    config = makeTrustedConfig();
  });

  it('serializes invocation.payload exactly once to OCTOPUS_INPUT', async () => {
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
    const { skill } = makeSkillFixture();
    await runner.run({
      skill,
      command: ['node', '/skill/scripts/invoke.js'],
      invocation: { payload: { query: 'tokyo' } },
    });
    const env = backend.lastRunSpec!.env!;
    expect(env.OCTOPUS_INPUT).toBe('{"query":"tokyo"}');
  });

  it('passes invocation.stdin through to ExecSpec.stdin (payload and stdin are separate)', async () => {
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
    const { skill } = makeSkillFixture();
    await runner.run({
      skill,
      command: ['node', '/skill/scripts/invoke.js'],
      invocation: { payload: { a: 1 }, stdin: 'hello-on-stdin' },
    });
    expect(backend.lastRunSpec!.stdin).toBe('hello-on-stdin');
    expect(backend.lastRunSpec!.env!.OCTOPUS_INPUT).toBe('{"a":1}');
  });

  it('env is minimal: allowlist + non-reserved caller keys + fixed guest HOME/TMPDIR/runtime PATH; no process.env spread', async () => {
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
    // poison host env to detect leaks
    process.env.OCTOPUS_HOST_ONLY_MARKER = 'should-not-leak';
    const { skill } = makeSkillFixture({ sandboxBlock: { bins: ['node'] } });
    await runner.run({
      skill,
      command: ['node', '/skill/scripts/invoke.js'],
      invocation: { env: { LANG: 'en_US.UTF-8', TZ: 'UTC', CUSTOM_OK: 'yes' } },
    });
    delete process.env.OCTOPUS_HOST_ONLY_MARKER;
    const env = backend.lastRunSpec!.env!;
    expect(env.OCTOPUS_HOST_ONLY_MARKER).toBeUndefined();
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.TZ).toBe('UTC');
    expect(env.CUSTOM_OK).toBe('yes');
    expect(env.HOME).toBe('/tmp/home');
    expect(env.TMPDIR).toBe('/tmp');
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin:/bin');
  });
});
