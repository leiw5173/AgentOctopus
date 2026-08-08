import { describe, it, expect } from 'vitest';
import { SandboxConfigSchema } from '../src/schema.js';

describe('windowsRuntime profile schema', () => {
  it('accepts a runtime profile carrying windowsRuntime', () => {
    const cfg = SandboxConfigSchema.parse({
      defaultBackend: 'windows',
      minIsolationLevel: 'restricted',
      runtimeProfiles: {
        'win-rt': {
          bins: ['node'],
          path: 'C:\\octopus\\rt',
          windowsRuntime: {
            manifestPath: 'C:\\octopus\\rt\\runtime.manifest.json',
            nodePath: 'C:\\octopus\\rt\\node.exe',
            bootstrapPath: 'C:\\octopus\\rt\\bootstrap.cjs',
          },
        },
      },
    });
    expect(cfg.runtimeProfiles?.['win-rt']?.windowsRuntime?.nodePath).toBe('C:\\octopus\\rt\\node.exe');
  });
});
