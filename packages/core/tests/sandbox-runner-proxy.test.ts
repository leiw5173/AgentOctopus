/**
 * SandboxRunner proxy integration + env hygiene tests.
 *
 * - The proxy is launched with a non-loopback reachable address (the launcher
 *   + carrier own that); the runner forwards handle.reachableAddr into
 *   backend.prepare.
 * - A per-session CA bundle path is forwarded.
 * - Env hygiene: minimal allowlist + non-resolved caller keys + fixed guest
 *   HOME / TMPDIR / runtime-profile PATH. process.env never spreads.
 * - Payload is serialized exactly once to OCTOPUS_INPUT; stdin passes through.
 *
 * I/O-seam coverage (NOT production proof): the orchestration-order block
 * below uses a poisoned legacy launcher and a recording backend to verify the
 * runner — the SOLE orchestration boundary — launches the proxy exactly once
 * and tears down in the documented order (backend before proxy handle). These
 * tests do NOT spin up real Docker/OS backends; they assert sequencing against
 * I/O seams. Real privileged lane assertions live in packages/sandbox/tests/security.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
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

/**
 * I/O-seam orchestration-order coverage (NOT production proof).
 *
 * These tests do NOT exercise a real OS/Docker backend. They use a recording
 * backend + a poisoned launcher to prove the SandboxRunner — the canonical
 * orchestration boundary — drives exactly one proxy launch and tears down in
 * the documented order: backend.cleanup() runs BEFORE the externally owned
 * proxy handle is closed. The poisoned legacy launcher asserts the runner does
 * not invoke a backend-supplied launcher: the proxy lifecycle is owned solely
 * by the runner's DefaultProxyLauncher seam.
 */
describe('SandboxRunner — orchestration order (I/O-seam, not production proof)', () => {
  let storeDir: string;
  let config: SandboxConfig;

  beforeEach(() => {
    storeDir = makeSnapshotStore();
    config = makeTrustedConfig();
  });

  it('launches the proxy exactly once and tears down backend before proxy handle (run path)', async () => {
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

    const names = log.map((e) => e.name);
    const launches = names.filter((n) => n === 'proxy.launch');
    expect(launches).toHaveLength(1);
    // backend.cleanup precedes proxy.close in the run-path teardown.
    const backendCleanupIdx = names.indexOf('backend.cleanup:docker');
    const proxyCloseIdx = names.indexOf('proxy.close');
    expect(backendCleanupIdx).toBeGreaterThanOrEqual(0);
    expect(proxyCloseIdx).toBeGreaterThanOrEqual(0);
    expect(backendCleanupIdx).toBeLessThan(proxyCloseIdx);
  });

  it('launches the proxy exactly once and tears down backend before proxy handle (spawn path)', async () => {
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
    await session.close();

    const names = log.map((e) => e.name);
    const launches = names.filter((n) => n === 'proxy.launch');
    expect(launches).toHaveLength(1);
    // spawn-path teardown order: process.close → backend.cleanup → proxy.close.
    const procCloseIdx = names.indexOf('process.close:docker');
    const backendCleanupIdx = names.indexOf('backend.cleanup:docker');
    const proxyCloseIdx = names.indexOf('proxy.close');
    expect(procCloseIdx).toBeGreaterThanOrEqual(0);
    expect(backendCleanupIdx).toBeGreaterThanOrEqual(0);
    expect(proxyCloseIdx).toBeGreaterThanOrEqual(0);
    expect(procCloseIdx).toBeLessThan(backendCleanupIdx);
    expect(backendCleanupIdx).toBeLessThan(proxyCloseIdx);
  });

  it('does not consult a poisoned legacy launcher on the backend; the runner owns the single launch', async () => {
    const { log, record } = makeEventLog();
    const backend = new RecordingBackend('os', 'full', record);
    // Poisoned legacy seam: if any code path hands the backend a launcher and
    // invokes it, this throws and the run must still surface a clean failure
    // (or success) — never a second launch. The runner's own launcher is the
    // recording one below; the poisoned launcher is attached to the backend
    // fixture only to prove the runner never delegates to it.
    const poisonedLegacyLaunch = vi.fn(async () => {
      throw new Error('poison: legacy backend launcher must never be invoked');
    });
    (backend as unknown as { proxyLauncher?: { launch: typeof poisonedLegacyLaunch } }).proxyLauncher = {
      launch: poisonedLegacyLaunch,
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
    await runner.run({ skill, command: ['node', '/skill/scripts/invoke.js'] });

    expect(poisonedLegacyLaunch).not.toHaveBeenCalled();
    const launches = log.map((e) => e.name).filter((n) => n === 'proxy.launch');
    expect(launches).toHaveLength(1);
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
