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
});
