/**
 * SandboxRunner snapshot integrity + command-rewrite tests.
 *
 * - verifySnapshot is the LAST filesystem integrity op before backend.prepare.
 * - A mutation between build and verify surfaces SNAPSHOT_MISMATCH and blocks
 *   prepare + run.
 * - Skill-side relative / live-dir paths are rewritten to /skill/... and no
 *   live dir appears in the final ExecSpec.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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

describe('SandboxRunner — snapshot integrity', () => {
  let storeDir: string;
  let config: SandboxConfig;

  beforeEach(() => {
    storeDir = makeSnapshotStore();
    config = makeTrustedConfig();
  });

  it('rejects with SNAPSHOT_MISMATCH when the snapshot is mutated between build and verify', async () => {
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
      afterBuildSnapshot: ({ snapshotRoot }) => {
        // mutate the snapshot in place — write a new file
        fs.writeFileSync(path.join(snapshotRoot, 'tampered.txt'), 'x');
      },
    });
    const { skill } = makeSkillFixture();

    const result = await runner.run({ skill, command: ['node', '/skill/scripts/invoke.js'] });
    expect(result.success).toBe(false);
    expect(result.error).toContain('SNAPSHOT_MISMATCH');
    // No backend.prepare / backend.run fired
    expect(eventNames(log)).not.toContain('backend.prepare:docker');
    expect(eventNames(log)).not.toContain('backend.run:docker');
  });

  it('verifySnapshot is the LAST filesystem op before backend.prepare', async () => {
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
    const { skill } = makeSkillFixture();
    await runner.run({ skill, command: ['node', '/skill/scripts/invoke.js'] });
    const names = eventNames(log);
    const verifyIdx = names.indexOf('snapshot.verify');
    const prepareIdx = names.indexOf('backend.prepare:docker');
    expect(verifyIdx).toBeGreaterThanOrEqual(0);
    expect(prepareIdx).toBeGreaterThan(verifyIdx);
    // No other snapshot op between verify and prepare
    expect(names.slice(verifyIdx + 1, prepareIdx)).not.toContain('snapshot.build');
  });
});

describe('SandboxRunner — command/path rewriting', () => {
  let storeDir: string;
  let config: SandboxConfig;

  beforeEach(() => {
    storeDir = makeSnapshotStore();
    config = makeTrustedConfig();
  });

  it('rewrites scripts/invoke.js → /skill/scripts/invoke.js and sets cwd to /skill', async () => {
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
    const { skill, dir } = makeSkillFixture();
    await runner.run({ skill, command: ['node', 'scripts/invoke.js'] });
    expect(backend.lastRunSpec).toBeDefined();
    expect(backend.lastRunSpec!.command).toEqual(['node', '/skill/scripts/invoke.js']);
    expect(backend.lastRunSpec!.cwd).toBe('/skill');
    // No live dir may appear anywhere in the spec
    const specJson = JSON.stringify(backend.lastRunSpec!);
    expect(specJson).not.toContain(dir);
  });

  it('rewrites absolute paths under skill.dirPath to /skill/...', async () => {
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
    const { skill, dir } = makeSkillFixture();
    const abs = path.join(dir, 'scripts', 'invoke.js');
    await runner.run({ skill, command: ['node', abs] });
    expect(backend.lastRunSpec!.command).toEqual(['node', '/skill/scripts/invoke.js']);
  });

  it('rejects a command path that escapes /skill', async () => {
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
    const result = await runner.run({
      skill,
      command: ['/etc/passwd'],
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/COMMAND_PATH_REJECTED|escapes \/skill/i);
    expect(backend.lastRunSpec).toBeUndefined();
  });

  it('rejects a live-dir path NOT under skill.dirPath', async () => {
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
    const result = await runner.run({
      skill,
      command: ['/usr/bin/curl', 'https://example.com'],
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/COMMAND_PATH_REJECTED|escapes \/skill/i);
  });
});
