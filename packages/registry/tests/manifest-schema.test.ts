import { describe, it, expect } from 'vitest';
import { SkillManifestSchema } from '../src/manifest-schema.js';

describe('SkillManifestSchema', () => {
  it('parses valid minimal schema with defaults', () => {
    const raw = {
      name: 'test-skill',
      description: 'A test skill'
    };
    
    const parsed = SkillManifestSchema.parse(raw);
    expect(parsed.name).toBe('test-skill');
    expect(parsed.adapter).toBe('http');
    expect(parsed.rating).toBe(3.0);
    expect(parsed.tags).toEqual([]);
  });

  it('fails on missing required fields', () => {
    const raw = { name: 'test-skill' };
    expect(() => SkillManifestSchema.parse(raw)).toThrowError();
  });

  it('parses credentials field', () => {
    const raw = {
      name: 'x-search',
      description: 'Search X',
      credentials: [
        { key: 'XAI_API_KEY', label: 'xAI API Key', required: true },
      ],
    };
    const parsed = SkillManifestSchema.parse(raw);
    expect(parsed.credentials).toHaveLength(1);
    expect(parsed.credentials![0]!.key).toBe('XAI_API_KEY');
    expect(parsed.credentials![0]!.required).toBe(true);
  });

  it('accepts manifest without credentials (optional)', () => {
    const raw = { name: 'weather', description: 'Weather skill' };
    const parsed = SkillManifestSchema.parse(raw);
    expect(parsed.credentials).toBeUndefined();
  });

  it('defaults credential required to true when omitted', () => {
    const parsed = SkillManifestSchema.parse({
      name: 'x-search',
      description: 'Search X',
      credentials: [{ key: 'XAI_API_KEY', label: 'xAI API Key' }],
    });
    expect(parsed.credentials![0]!.required).toBe(true);
  });

  it('rejects credential with invalid key format', () => {
    expect(() => SkillManifestSchema.parse({
      name: 'test',
      description: 'test',
      credentials: [{ key: 'invalid key with spaces', label: 'label' }],
    })).toThrowError();
  });

  it('accepts an untrusted sandbox.request block (requests only)', () => {
    const parsed = SkillManifestSchema.parse({
      name: 'weather',
      description: 'Weather skill',
      sandbox: {
        hosts: ['wttr.in'],
        credentials: ['WTR_API_KEY'],
        resources: { memory: '256m', timeoutMs: 20000 },
      },
    });
    expect(parsed.sandbox?.hosts).toEqual(['wttr.in']);
    expect(parsed.sandbox?.credentials).toEqual(['WTR_API_KEY']);
  });

  it('rejects trusted/grant keys in the untrusted sandbox manifest block', () => {
    const base = { name: 'x', description: 'x' };
    for (const bad of [
      { sandbox: { grants: [] } },
      { sandbox: { defaultBackend: 'docker' } },
      { sandbox: { minIsolationLevel: 'none' } },
      { sandbox: { docker: {} } },
      { sandbox: { proxy: {} } },
      { sandbox: { runtimeProfiles: {} } },
      { sandbox: { backend: 'docker' } },
      { sandbox: { image: 'alpine' } },
      { sandbox: { credentials: [{ key: 'K', host: 'x' }] } },
    ]) {
      expect(() => SkillManifestSchema.parse({ ...base, ...bad })).toThrow();
    }
  });
});
