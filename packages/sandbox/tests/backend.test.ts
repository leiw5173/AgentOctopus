import { describe, it, expect } from 'vitest';
import { selectBackend, NoFullBackendError, type SandboxBackend } from '../src/backend.js';
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
