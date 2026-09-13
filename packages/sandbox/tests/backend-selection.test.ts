import { describe, it, expect } from 'vitest';
import { selectBackend } from '../src/backend.js';
import type { SandboxBackend } from '../src/backend.js';
import { SandboxConfigSchema } from '../src/schema.js';

function fakeWindowsBackend(): SandboxBackend {
  return {
    kind: 'windows',
    isolationLevel: 'restricted',
    probe: async () => true,
    prepareTopology: async () => ({ kind: 'in-process', listenHost: '127.0.0.1', reachableHost: '127.0.0.1' }),
    prepare: async () => {},
    spawn: async () => { throw new Error('not used'); },
    run: async () => { throw new Error('not used'); },
    cleanup: async () => {},
  } as unknown as SandboxBackend;
}

describe('windows restricted opt-in gate', () => {
  it('excludes windows restricted backend under auto+full', async () => {
    const cfg = SandboxConfigSchema.parse({ defaultBackend: 'auto', minIsolationLevel: 'full' });
    await expect(selectBackend(cfg, [fakeWindowsBackend()])).rejects.toThrow();
  });
  it('excludes windows restricted backend under auto+restricted (not explicitly requested)', async () => {
    const cfg = SandboxConfigSchema.parse({ defaultBackend: 'auto', minIsolationLevel: 'restricted' });
    await expect(selectBackend(cfg, [fakeWindowsBackend()])).rejects.toThrow();
  });
  it('selects windows backend when defaultBackend=windows AND floor=restricted', async () => {
    const cfg = SandboxConfigSchema.parse({ defaultBackend: 'windows', minIsolationLevel: 'restricted' });
    const b = await selectBackend(cfg, [fakeWindowsBackend()]);
    expect(b.kind).toBe('windows');
  });
});
