import { describe, it, expect } from 'vitest';
import { SandboxConfigSchema } from '../src/config-types.js';
import type { SandboxConfigSection } from '../src/config-types.js';

describe('core sandbox config (canonical re-export from @agentoctopus/sandbox)', () => {
  it('is the canonical sandbox schema, not a locally defined one', () => {
    // Defaults come from the trusted @agentoctopus/sandbox schema.
    expect(SandboxConfigSchema.parse({})).toMatchObject({
      defaultBackend: 'auto',
      minIsolationLevel: 'full',
      grants: [],
      runtimeProfiles: {},
    });
  });

  it('does not accept legacy openshell backend (must name supported choices)', () => {
    expect(() => SandboxConfigSchema.parse({ defaultBackend: 'openshell' })).toThrow(
      /auto.*docker.*os.*subprocess.*ssh.*none/s,
    );
  });

  it('does not expose an ssh block on the canonical config', () => {
    // Old shape had ssh: {host,user,keyPath}. The canonical schema is .strict()
    // and has no ssh key — an ssh block must be rejected, not silently dropped.
    expect(() =>
      SandboxConfigSchema.parse({ ssh: { host: 'h', user: 'u', keyPath: '/k' } }),
    ).toThrow();
  });

  it('double-parses a grant and preserves installationId/digest/hosts/credentials (trusted round-trip)', () => {
    const digest = 'a'.repeat(64);
    const grant = {
      installationId: 'u-1',
      digest: `sha256:${digest}`,
      hosts: ['wttr.in'],
      credentials: [
        {
          key: 'WTR_API_KEY',
          host: 'wttr.in',
          port: 443,
          scheme: 'https' as const,
          methods: ['GET'],
          pathPrefix: '/data',
          header: 'Authorization',
          prefix: 'Bearer ',
        },
      ],
    };
    const once = SandboxConfigSchema.parse({ grants: [grant] });
    const twice = SandboxConfigSchema.parse(once);
    expect(twice.grants[0]!.installationId).toBe('u-1');
    expect(twice.grants[0]!.digest).toBe(`sha256:${digest}`);
    expect(twice.grants[0]!.hosts).toEqual(['wttr.in']);
    expect(twice.grants[0]!.credentials).toHaveLength(1);
    expect(twice.grants[0]!.credentials![0]!.key).toBe('WTR_API_KEY');
    expect(twice.grants[0]!.credentials![0]!.header).toBe('Authorization');
  });

  it('SandboxConfigSection type matches canonical SandboxConfig', () => {
    // Type-level assertion: the re-exported type is the same shape.
    const cfg: SandboxConfigSection = SandboxConfigSchema.parse({});
    expect(cfg.defaultBackend).toBe('auto');
    expect(cfg.minIsolationLevel).toBe('full');
  });
});
