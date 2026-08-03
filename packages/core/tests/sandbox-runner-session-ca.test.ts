/**
 * SandboxRunner per-session working directory + exclusive CA bundle tests (T2).
 *
 * Regression target: previously the runner passed `path.dirname(snapshotRoot)`
 * as the proxy workDir, so every concurrent session wrote its egress-proxy CA
 * to the SAME shared `<store>/<digest-parent>/ca.pem`, overwriting each other.
 *
 * Now the runner creates a unique private `mkdtemp` session dir (0700) under
 * `<snapshotStoreDir>/sessions/`, passes it as `workDir`, the launcher writes
 * `<sessionDir>/ca.pem` EXCLUSIVELY, and the runner removes the session dir in
 * every exit path AFTER `proxyHandle.close()`.
 *
 * Concurrency design: two `SandboxRunner.run()` calls race through
 * prepareSession. A barrier-holding backend blocks each session's
 * `backend.run()` until BOTH sessions have completed `backend.prepare` (and
 * therefore both CA bundles exist on disk). While both are held, we assert the
 * two captured `caBundlePath`s differ, both PEM files exist with distinct
 * contents, and each file is byte-stable from capture until that session's
 * close. After both runs resolve, both session dirs must be removed.
 *
 * The launcher here writes a REAL SessionCa bundle via the real writeCaBundle
 * (same as DefaultProxyLauncher) so on-disk assertions exercise the actual
 * production write path rather than a stub.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SessionCa,
  writeCaBundle,
  type BackendPrepareOptions,
  type BackendRunResult,
  type ExecSpec,
  type ProxyCarrier,
  type ProxyHandle,
  type ProxyLauncher,
  type SandboxConfig,
  type SandboxPolicy,
  type ResolvedSecrets,
} from '@agentoctopus/sandbox';
import { SandboxRunner } from '../src/sandbox-runner.js';
import {
  RecordingBackend,
  RecordingSecretProvider,
  makeEventLog,
  makeSkillFixture,
  makeSnapshotStore,
  makeTrustedConfig,
} from './sandbox-runner.test.js';

/** Launcher that writes a REAL per-session CA bundle into opts.workDir. */
class RealCaWritingLauncher implements ProxyLauncher {
  readonly launchedWorkDirs: string[] = [];
  async launch(
    opts: { policy: SandboxPolicy; secrets: ResolvedSecrets; workDir: string },
    _carrier: ProxyCarrier,
  ): Promise<ProxyHandle> {
    this.launchedWorkDirs.push(opts.workDir);
    const ca = SessionCa.create();
    const caBundlePath = await writeCaBundle(opts.workDir, ca);
    return {
      reachableAddr: 'http://10.0.0.1:8888',
      caBundlePath,
      close: async () => {
        ca.destroy();
      },
    };
  }
}

/** Backend whose run() blocks on a shared barrier until released. */
class BarrierBackend extends RecordingBackend {
  capturedPrepare?: BackendPrepareOptions;
  private releaseRun!: () => void;
  readonly runGate: Promise<void> = new Promise<void>((resolve) => {
    this.releaseRun = resolve;
  });

  override async prepare(opts: BackendPrepareOptions): Promise<void> {
    await super.prepare(opts);
    this.capturedPrepare = opts;
  }

  release(): void {
    this.releaseRun();
  }

  override async run(spec: ExecSpec): Promise<BackendRunResult> {
    await this.runGate;
    return super.run(spec);
  }
}

describe('SandboxRunner — per-session workDir + exclusive CA bundle (T2)', () => {
  let storeDir: string;
  let config: SandboxConfig;

  beforeEach(() => {
    storeDir = makeSnapshotStore();
    config = makeTrustedConfig();
  });

  it('two concurrent sessions get distinct private CA bundles; session dirs removed at cleanup', async () => {
    const { record } = makeEventLog();
    const backendA = new BarrierBackend('docker', 'full', record);
    const backendB = new BarrierBackend('docker', 'full', record);
    const launcher = new RealCaWritingLauncher();

    // Two runners sharing ONE snapshot store (the concurrent-session scenario).
    const runnerA = new SandboxRunner({
      config,
      snapshotStoreDir: storeDir,
      backends: [backendA],
      proxyLauncher: launcher,
      secretProvider: new RecordingSecretProvider(),
      installationIdFor: () => 'inst-1',
      onEvent: record,
    });
    const runnerB = new SandboxRunner({
      config,
      snapshotStoreDir: storeDir,
      backends: [backendB],
      proxyLauncher: launcher,
      secretProvider: new RecordingSecretProvider(),
      installationIdFor: () => 'inst-1',
      onEvent: record,
    });

    const { skill: skillA } = makeSkillFixture({ name: 'weather-a' });
    const { skill: skillB } = makeSkillFixture({ name: 'weather-b' });

    const runA = runnerA.run({ skill: skillA, command: ['node', '/skill/scripts/invoke.js'] });
    const runB = runnerB.run({ skill: skillB, command: ['node', '/skill/scripts/invoke.js'] });

    // Wait until BOTH sessions have prepared (both CA bundles on disk).
    const deadline = Date.now() + 10_000;
    while ((!backendA.capturedPrepare || !backendB.capturedPrepare) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(backendA.capturedPrepare).toBeDefined();
    expect(backendB.capturedPrepare).toBeDefined();

    const caPathA = backendA.capturedPrepare!.caBundlePath;
    const caPathB = backendB.capturedPrepare!.caBundlePath;

    // (1) CA paths differ from each other and from the shared store/dirname root.
    expect(caPathA).not.toBe(caPathB);
    const sharedParent = path.dirname(backendA.capturedPrepare!.snapshotRoot);
    expect(caPathA).not.toBe(path.join(sharedParent, 'ca.pem'));
    expect(caPathB).not.toBe(path.join(sharedParent, 'ca.pem'));
    expect(caPathA.startsWith(storeDir)).toBe(true);
    expect(caPathB.startsWith(storeDir)).toBe(true);

    // Both files exist with distinct PEM contents DURING execution.
    const pemA0 = await fsp.readFile(caPathA, 'utf8');
    const pemB0 = await fsp.readFile(caPathB, 'utf8');
    expect(pemA0).toContain('BEGIN CERTIFICATE');
    expect(pemB0).toContain('BEGIN CERTIFICATE');
    expect(pemA0).not.toBe(pemB0);

    // (3) Byte-stability: re-read each file and confirm it has not changed
    // while the sibling session is alive (i.e. no cross-session overwrite).
    const pemA1 = await fsp.readFile(caPathA, 'utf8');
    const pemB1 = await fsp.readFile(caPathB, 'utf8');
    expect(pemA1).toBe(pemA0);
    expect(pemB1).toBe(pemB0);

    const dirA = path.dirname(caPathA);
    const dirB = path.dirname(caPathB);
    expect(fs.existsSync(dirA)).toBe(true);
    expect(fs.existsSync(dirB)).toBe(true);

    // Session dirs are private (0700).
    expect((await fsp.stat(dirA)).mode & 0o777).toBe(0o700);
    expect((await fsp.stat(dirB)).mode & 0o777).toBe(0o700);

    // Release both runs; cleanup must remove each session dir.
    backendA.release();
    backendB.release();
    const [outA, outB] = await Promise.all([runA, runB]);
    expect(outA.success).toBe(true);
    expect(outB.success).toBe(true);

    // (4) After close, both session dirs are removed.
    expect(fs.existsSync(dirA)).toBe(false);
    expect(fs.existsSync(dirB)).toBe(false);
    expect(fs.existsSync(caPathA)).toBe(false);
    expect(fs.existsSync(caPathB)).toBe(false);
  });

  it('removes the session dir even when backend.run throws (error path cleanup)', async () => {
    const { record } = makeEventLog();
    const backend = new RecordingBackend('docker', 'full', record);
    backend.shouldFailRun = new Error('boom');
    const launcher = new RealCaWritingLauncher();
    const runner = new SandboxRunner({
      config,
      snapshotStoreDir: storeDir,
      backends: [backend],
      proxyLauncher: launcher,
      secretProvider: new RecordingSecretProvider(),
      installationIdFor: () => 'inst-1',
      onEvent: record,
    });
    const { skill } = makeSkillFixture();
    const result = await runner.run({ skill, command: ['node', '/skill/scripts/invoke.js'] });
    expect(result.success).toBe(false);
    expect(launcher.launchedWorkDirs).toHaveLength(1);
    expect(fs.existsSync(launcher.launchedWorkDirs[0]!)).toBe(false);
  });

  it('removes the session dir when prepareSession fails AFTER proxy launch (prepare throw path)', async () => {
    const { record } = makeEventLog();
    const backend = new RecordingBackend('docker', 'full', record);
    backend.shouldFailPrepare = new Error('prepare-boom');
    const launcher = new RealCaWritingLauncher();
    const runner = new SandboxRunner({
      config,
      snapshotStoreDir: storeDir,
      backends: [backend],
      proxyLauncher: launcher,
      secretProvider: new RecordingSecretProvider(),
      installationIdFor: () => 'inst-1',
      onEvent: record,
    });
    const { skill } = makeSkillFixture();
    const result = await runner.run({ skill, command: ['node', '/skill/scripts/invoke.js'] });
    expect(result.success).toBe(false);
    expect(launcher.launchedWorkDirs).toHaveLength(1);
    expect(fs.existsSync(launcher.launchedWorkDirs[0]!)).toBe(false);
  });

  it('spawn-path close() removes the session dir', async () => {
    const { record } = makeEventLog();
    const backend = new RecordingBackend('docker', 'full', record);
    const launcher = new RealCaWritingLauncher();
    const runner = new SandboxRunner({
      config,
      snapshotStoreDir: storeDir,
      backends: [backend],
      proxyLauncher: launcher,
      secretProvider: new RecordingSecretProvider(),
      installationIdFor: () => 'inst-1',
      onEvent: record,
    });
    const { skill } = makeSkillFixture();
    const session = await runner.spawn({ skill, command: ['node', '/skill/scripts/invoke.js'] });
    expect(launcher.launchedWorkDirs).toHaveLength(1);
    const sessionDir = launcher.launchedWorkDirs[0]!;
    expect(fs.existsSync(sessionDir)).toBe(true);
    await session.close();
    expect(fs.existsSync(sessionDir)).toBe(false);
  });

  it('session root lives under <snapshotStoreDir>/sessions with mode 0700', async () => {
    const { record } = makeEventLog();
    const backend = new RecordingBackend('docker', 'full', record);
    const launcher = new RealCaWritingLauncher();
    const runner = new SandboxRunner({
      config,
      snapshotStoreDir: storeDir,
      backends: [backend],
      proxyLauncher: launcher,
      secretProvider: new RecordingSecretProvider(),
      installationIdFor: () => 'inst-1',
      onEvent: record,
    });
    const { skill } = makeSkillFixture();
    await runner.run({ skill, command: ['node', '/skill/scripts/invoke.js'] });
    expect(launcher.launchedWorkDirs).toHaveLength(1);
    const sessionDir = launcher.launchedWorkDirs[0]!;
    expect(path.dirname(sessionDir)).toBe(path.join(storeDir, 'sessions'));
    expect(path.basename(sessionDir)).toMatch(/^oct-session-/);
    // session root persists (only the per-session leaf is removed).
    const sessionRootStat = await fsp.stat(path.join(storeDir, 'sessions'));
    expect(sessionRootStat.mode & 0o777).toBe(0o700);
  });
});
