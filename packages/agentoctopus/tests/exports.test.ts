import { describe, it, expect } from 'vitest';
// Import from built dist so the umbrella's sandbox re-export is exercised
// end-to-end through package linkage (agentoctopus -> @agentoctopus/sandbox).
import { SandboxRequestSchema, SandboxConfigSchema } from '../dist/index.js';
import type { SandboxRequest, SandboxConfig } from '../dist/index.js';

describe('agentoctopus umbrella — sandbox re-exports', () => {
  it('re-exports the canonical sandbox schemas', () => {
    expect(SandboxRequestSchema).toBeDefined();
    expect(SandboxConfigSchema).toBeDefined();
    expect(SandboxConfigSchema.parse({})).toMatchObject({
      defaultBackend: 'auto',
      minIsolationLevel: 'full',
    });
  });

  it('re-exported schemas parse correctly', () => {
    const req: SandboxRequest = SandboxRequestSchema.parse({ hosts: ['wttr.in'] });
    expect(req.hosts).toEqual(['wttr.in']);
    const cfg: SandboxConfig = SandboxConfigSchema.parse({});
    expect(cfg.grants).toEqual([]);
  });
});
