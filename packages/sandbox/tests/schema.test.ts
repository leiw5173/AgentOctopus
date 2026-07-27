import { describe, it, expect } from 'vitest';
import {
  SandboxRequestSchema,
  InstallationGrantSchema,
  ImmutableImageRefSchema,
  SandboxConfigSchema,
} from '../src/schema.js';

describe('sandbox schemas', () => {
  it('validates an untrusted sandbox.request block', () => {
    const r = SandboxRequestSchema.parse({
      hosts: ['wttr.in'],
      credentials: ['WTR_API_KEY'],
      resources: { memory: '256m', timeoutMs: 20000 },
    });
    expect(r.hosts).toEqual(['wttr.in']);
  });

  it('rejects a credential grant missing a required field', () => {
    const bad = {
      installationId: 'u',
      digest: 'sha256:x',
      credentials: [{ key: 'K', host: 'h' }], // missing port/scheme/methods/pathPrefix/header
    };
    expect(() => InstallationGrantSchema.parse(bad)).toThrow();
  });

  it('accepts only immutable digest-pinned Docker image references', () => {
    const digest = 'a'.repeat(64);
    expect(ImmutableImageRefSchema.parse(`alpine@sha256:${digest}`)).toBe(`alpine@sha256:${digest}`);
    // Bare local content ID (from `docker image inspect --format '{{.Id}}'`).
    expect(ImmutableImageRefSchema.parse(`sha256:${digest}`)).toBe(`sha256:${digest}`);
    expect(() => ImmutableImageRefSchema.parse('example/runtime:latest')).toThrow();
    expect(() => ImmutableImageRefSchema.parse('alpine@sha256:abc')).toThrow();
  });

  it('applies config defaults (fail-closed auto, full min level)', () => {
    const c = SandboxConfigSchema.parse({});
    expect(c.defaultBackend).toBe('auto');
    expect(c.minIsolationLevel).toBe('full');
    expect(c.defaults).toMatchObject({ memory: '512m', timeoutMs: 30000, cpus: '0.5' });
  });

  it('accepts a full credential grant', () => {
    const g = InstallationGrantSchema.parse({
      installationId: 'u1',
      digest: 'sha256:abc',
      hosts: ['wttr.in'],
      credentials: [{
        key: 'WTR_API_KEY', host: 'wttr.in', port: 443, scheme: 'https',
        methods: ['GET'], pathPrefix: '/data', header: 'Authorization', prefix: 'Bearer ',
      }],
    });
    expect(g.credentials?.[0]?.pathPrefix).toBe('/data');
  });
});
