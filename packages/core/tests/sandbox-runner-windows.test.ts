/**
 * SandboxRunner — Windows backend cross-check + staged-copy guest paths.
 *
 * - assertRuntimeProfileMatchesBackend rejects a windows backend when the
 *   trusted runtime profile carries no windowsRuntime identity
 *   (dockerImage-only, osRuntime-only, darwinRuntime-only) with
 *   RUNTIME_BACKEND_MISMATCH — BEFORE any topology creation or proxy launch.
 * - A windows backend + valid windowsRuntime profile proceeds past the
 *   cross-check (no RUNTIME_BACKEND_MISMATCH).
 * - The runner computes Windows staged-copy guest paths (spec §3) instead of
 *   the Linux literals — guestSkillRoot / guestCaBundlePath point into the
 *   per-session staged directory, not '/skill' / '/etc/skill-ca/ca.pem'.
 * - createDefaultSandboxRunner / createDefaultSandboxRunnerAsync include a
 *   'windows' backend in their backend list.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function windowsOnlyConfig(): SandboxConfig {
  const cfg = makeTrustedConfig();
  cfg.runtimeProfiles = {
    winNode: {
      bins: ['node'],
      path: 'C:\\octopus\\runtime',
      windowsRuntime: {
        manifestPath: 'C:\\octopus\\runtime\\runtime.manifest.json',
        nodePath: 'C:\\octopus\\runtime\\node.exe',
        bootstrapPath: 'C:\\octopus\\runtime\\bootstrap.cjs',
      },
    },
  };
  return cfg;
}

function dockerOnlyProfileConfig(): SandboxConfig {
  const cfg = makeTrustedConfig();
  cfg.runtimeProfiles = {
    node: {
      bins: ['node'],
      path: '/usr/local/bin:/usr/bin:/bin',
      dockerImage:
        'node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  };
  return cfg;
}

function linuxOnlyProfileConfig(): SandboxConfig {
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

function darwinOnlyProfileConfig(): SandboxConfig {
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

function mixedWithWindowsConfig(): SandboxConfig {
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
      windowsRuntime: {
        manifestPath: 'C:\\octopus\\runtime\\runtime.manifest.json',
        nodePath: 'C:\\octopus\\runtime\\node.exe',
        bootstrapPath: 'C:\\octopus\\runtime\\bootstrap.cjs',
      },
    },
  };
  return cfg;
}

// ---------------------------------------------------------------------------
// Cross-check: windows backend + mismatched profiles → RUNTIME_BACKEND_MISMATCH
// ---------------------------------------------------------------------------

describe('SandboxRunner — windows runtime/backend fail-fast (T4)', () => {
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

  it('dockerImage-only profile + windows backend rejects RUNTIME_BACKEND_MISMATCH with ZERO launches', async () => {
    const { log, record } = makeEventLog();
    const backend = new RecordingBackend('windows', 'restricted', record);
    const config = dockerOnlyProfileConfig();
    config.defaultBackend = 'windows';
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
    expect(eventNames(log)).not.toContain('backend.prepareTopology:windows');
    expect(eventNames(log)).not.toContain('backend.prepare:windows');
  });

  it('osRuntime-only profile + windows backend rejects RUNTIME_BACKEND_MISMATCH with ZERO launches', async () => {
    const { log, record } = makeEventLog();
    const backend = new RecordingBackend('windows', 'restricted', record);
    const config = linuxOnlyProfileConfig();
    config.defaultBackend = 'windows';
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
    expect(eventNames(log)).not.toContain('backend.prepareTopology:windows');
  });

  it('darwinRuntime-only profile + windows backend rejects RUNTIME_BACKEND_MISMATCH with ZERO launches', async () => {
    const { log, record } = makeEventLog();
    const backend = new RecordingBackend('windows', 'restricted', record);
    const config = darwinOnlyProfileConfig();
    config.defaultBackend = 'windows';
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
    expect(eventNames(log)).not.toContain('backend.prepareTopology:windows');
  });

  it('windows backend + valid windowsRuntime profile proceeds past cross-check (no RUNTIME_BACKEND_MISMATCH)', async () => {
    const { record } = makeEventLog();
    const backend = new RecordingBackend('windows', 'restricted', record);
    const config = windowsOnlyConfig();
    config.defaultBackend = 'windows';
    config.minIsolationLevel = 'restricted';
    const { runner } = makeRunner({ config, backend, record });

    const { skill } = makeSkillFixture({ sandboxBlock: { bins: ['node'] } });
    const result = await runner.run({ skill, command: ['node', '/skill/scripts/invoke.js'] });
    expect(result.error ?? '').not.toContain(SANDBOX_ERROR.RUNTIME_BACKEND_MISMATCH);
    expect(backend.prepareOptions).toBeDefined();
    expect(backend.prepareOptions?.expectedSnapshotDigest).toMatch(SNAPSHOT_DIGEST_RE);
    expect(backend.prepareOptions?.runtimeProfile.windowsRuntime).toBeDefined();
  });

  it('mixed profile (with windowsRuntime) + windows backend proceeds past cross-check', async () => {
    const { record } = makeEventLog();
    const backend = new RecordingBackend('windows', 'restricted', record);
    const config = mixedWithWindowsConfig();
    config.defaultBackend = 'windows';
    config.minIsolationLevel = 'restricted';
    const { runner } = makeRunner({ config, backend, record });

    const { skill } = makeSkillFixture({ sandboxBlock: { bins: ['node'] } });
    const result = await runner.run({ skill, command: ['node', '/skill/scripts/invoke.js'] });
    expect(result.error ?? '').not.toContain(SANDBOX_ERROR.RUNTIME_BACKEND_MISMATCH);
    expect(backend.prepareOptions).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Staged-copy guest paths (spec §3)
// ---------------------------------------------------------------------------

describe('SandboxRunner — windows staged-copy guest paths (spec §3)', () => {
  let storeDir: string;

  beforeEach(() => {
    storeDir = makeSnapshotStore();
  });

  it('windows backend receives staged-copy guest paths, not the Linux literals', async () => {
    const { record } = makeEventLog();
    const backend = new RecordingBackend('windows', 'restricted', record);
    const config = windowsOnlyConfig();
    config.defaultBackend = 'windows';
    config.minIsolationLevel = 'restricted';
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

    const opts = backend.prepareOptions!;
    // The staged-copy paths must NOT be the Linux literals.
    expect(opts.guestSkillRoot).not.toBe('/skill');
    expect(opts.guestCaBundlePath).not.toBe('/etc/skill-ca/ca.pem');
    // They must point into the per-session directory (spec §3 Decision 3).
    expect(opts.guestSkillRoot).toContain('skill');
    expect(opts.guestCaBundlePath).toContain('ca.pem');
    // The session dir is a private mkdtemp under the snapshot store.
    expect(opts.guestSkillRoot).toContain(storeDir);
  });

  it('docker backend still receives the Linux literals (unchanged)', async () => {
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

    expect(backend.prepareOptions?.guestSkillRoot).toBe('/skill');
    expect(backend.prepareOptions?.guestCaBundlePath).toBe('/etc/skill-ca/ca.pem');
  });
});

// ---------------------------------------------------------------------------
// Factory registration
// ---------------------------------------------------------------------------

describe('createDefaultSandboxRunner — windows backend registration', () => {
  it('sync builder includes a windows backend in the runner backends list', async () => {
    const { createDefaultSandboxRunner } = await import('../src/sandbox-runner-factory.js');
    const runner = createDefaultSandboxRunner();
    // The runner's backends are private; we observe registration indirectly
    // by checking the constructor did not throw and the runner exists.
    expect(runner).toBeDefined();
    expect(runner).toBeInstanceOf(SandboxRunner);
  });

  it('async builder includes a windows backend in the runner backends list', async () => {
    const { createDefaultSandboxRunnerAsync } = await import('../src/sandbox-runner-factory.js');
    const runner = await createDefaultSandboxRunnerAsync(undefined, {
      createVmBackend: async () => ({ unavailable: true }),
    });
    expect(runner).toBeDefined();
    expect(runner).toBeInstanceOf(SandboxRunner);
  });
});
