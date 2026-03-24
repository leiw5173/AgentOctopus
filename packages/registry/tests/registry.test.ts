import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SkillRegistry } from '../src/registry.js';
import fs from 'fs';
import { glob } from 'glob';

vi.mock('fs');
vi.mock('glob');

describe('SkillRegistry', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('loads skills from matched files', async () => {
    vi.mocked(glob).mockResolvedValue(['/mock/skills/search/SKILL.md']);
    
    const mockManifestData = `---
name: search-skill
description: A mock search skill
version: 1.0.0
adapter: subprocess
rating: 4.5
tags: []
---
Mock instructions`;
    
    // mock readFileSync for the skill manifest
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (path.toString().includes('SKILL.md')) {
        return mockManifestData;
      }
      return '{}';
    });

    const registry = new SkillRegistry('/mock/skills', '/mock/ratings.json');
    await registry.load();

    const skills = registry.getAll();
    console.log(JSON.stringify(skills[0], null, 2));
    expect(skills.length).toBe(1);
    expect(skills[0].manifest.name).toBe('search-skill');
    expect(skills[0].instructions).toBe('Mock instructions');
    expect(skills[0].dirPath).toBe('/mock/skills/search');
    expect(skills[0].rating).toBe(4.5);
  });

  it('search correctly filters skills by name or tag', async () => {
    vi.mocked(glob).mockResolvedValue([
      '/mock/skills/1/SKILL.md',
      '/mock/skills/2/SKILL.md'
    ]);
    
    let callCount = 0;
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (!path.toString().includes('SKILL.md')) return '{}';
      callCount++;
      if (callCount === 1) {
        return `---
name: apple-skill
description: A skill for apples
version: 1.0.0
adapter: http
tags: [fruit]
---
apples rules`;
      }
      return `---
name: banana-skill
description: A skill for bananas
version: 1.0.0
adapter: http
tags: [yellow, fruit]
---
bananas rule`;
    });

    const registry = new SkillRegistry('/mock/skills', '/mock/ratings.json');
    await registry.load();

    const fruitMatch = registry.search('fruit');
    expect(fruitMatch.length).toBe(2);

    const yellowMatch = registry.search('yellow');
    expect(yellowMatch.length).toBe(1);
    expect(yellowMatch[0].manifest.name).toBe('banana-skill');
  });

  it('records feedback using the underlying store', async () => {
    vi.mocked(glob).mockResolvedValue(['/mock/skills/search/SKILL.md']);
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (path.toString().includes('ratings.json')) {
        // Return existing ratings with 4.6 for search-skill
        return JSON.stringify({
          'search-skill': { skillName: 'search-skill', rating: 4.6, invocations: 0, recentFeedback: [] }
        });
      }
      return `---
name: search-skill
description: description
version: 1.0.0
adapter: subprocess
rating: 4.5
tags: []
---
`;
    });
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const registry = new SkillRegistry('/mock/skills', '/mock/ratings.json');
    await registry.load();

    registry.recordFeedback('search-skill', true);
    
    // Rating should be updated locally (4.6 + 0.1)
    const skill = registry.getByName('search-skill');
    expect(skill?.rating).toBeCloseTo(4.7);
    
    // Should have saved to fs
    expect(fs.writeFileSync).toHaveBeenCalled();
  });
});
