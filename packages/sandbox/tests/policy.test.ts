import { describe, it, expect } from 'vitest';
import { resolvePolicy, clampResources } from '../src/policy.js';
import type { SandboxSkillDescriptor } from '../src/types.js';
import { SandboxConfigSchema } from '../src/schema.js';

const desc = (over: Partial<SandboxSkillDescriptor['request']> = {}, digest = 'sha256:a'): SandboxSkillDescriptor => ({
  identity: { installationId: 'u1', digest, snapshotRef: digest, name: 'weather' },
  snapshotRoot: '/snap/sha256:a',
  request: { hosts: ['wttr.in', 'evil.com'], credentials: ['WTR_API_KEY', 'OTHER_KEY'], ...over },
});

const config = SandboxConfigSchema.parse({
  grants: [{
    installationId: 'u1', digest: 'sha256:a',
    hosts: ['wttr.in', '*.example.com', '*.co.uk'],
    credentials: [{ key: 'WTR_API_KEY', host: 'wttr.in', port: 443, scheme: 'https', methods: ['GET'], pathPrefix: '/data', header: 'Authorization' }],
  }],
  defaults: { memory: '512m', timeoutMs: 30000, cpus: '1.5' },
});

describe('resolvePolicy (requested ∩ granted)', () => {
  it('intersects hosts and drops ungranted ones into denied', () => {
    const p = resolvePolicy(desc(), config);
    expect(p.hosts).toEqual(['wttr.in']);
    expect(p.denied.hosts).toEqual(['evil.com']);
  });

  it('applies trusted wildcard grants to concrete requested hosts only', () => {
    const p = resolvePolicy(desc({ hosts: ['api.example.com', 'example.com', 'shop.co.uk'] }), config);
    expect(p.hosts).toEqual(['api.example.com']);
    expect(p.denied.hosts).toEqual(['example.com', 'shop.co.uk']);
  });

  it('grants only credentials the skill requested AND the grant allows', () => {
    const p = resolvePolicy(desc(), config);
    expect(p.credentials.map(c => c.key)).toEqual(['WTR_API_KEY']);
    expect(p.denied.credentials).toEqual(['OTHER_KEY']);
  });

  it('returns empty grants when digest does not match (stale content)', () => {
    const p = resolvePolicy(desc({}, 'sha256:CHANGED'), config);
    expect(p.hosts).toEqual([]);
    expect(p.credentials).toEqual([]);
  });

  it('parses and clamps every resource dimension to trusted caps', () => {
    const p = resolvePolicy(desc({ resources: { memory: '999999g', timeoutMs: 999_999_999, cpus: '999999' } }), config);
    expect(p.resources).toEqual({ memoryBytes: 512 * 1024 * 1024, timeoutMs: 30000, cpus: 1.5 });
  });

  it('rejects malformed untrusted resource strings before backend preparation', () => {
    expect(() => resolvePolicy(desc({ resources: { memory: 'not-memory', cpus: 'NaN' } }), config)).toThrow();
  });

  it('allows a skill to request smaller resources and returns canonical values', () => {
    const p = resolvePolicy(desc({ resources: { memory: '128m', timeoutMs: 5000, cpus: '0.25' } }), config);
    expect(p.resources).toEqual({ memoryBytes: 128 * 1024 * 1024, timeoutMs: 5000, cpus: 0.25 });
  });
});

describe('clampResources (trusted caps required)', () => {
  it('throws when trusted memory cap is missing', () => {
    expect(() => clampResources(undefined, { timeoutMs: 30000, cpus: '1' })).toThrow(/memory/i);
  });

  it('throws when trusted timeoutMs cap is missing', () => {
    expect(() => clampResources(undefined, { memory: '512m', cpus: '1' })).toThrow(/timeout/i);
  });

  it('throws when trusted cpus cap is missing', () => {
    expect(() => clampResources(undefined, { memory: '512m', timeoutMs: 30000 })).toThrow(/cpu/i);
  });
});
