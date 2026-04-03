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
});
