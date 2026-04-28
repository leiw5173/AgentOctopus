import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SkillRegistry } from '../src/registry.js';
import fs from 'fs';
import { glob } from 'glob';

vi.mock('fs');
vi.mock('glob');
vi.mock('@agentoctopus/skills', () => ({
  loadSkillsFromDir: vi.fn(),
}));

describe('SkillRegistry', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('loads skills via the skills package and transforms them', async () => {
    vi.mocked(glob).mockResolvedValue([]);
    const { loadSkillsFromDir } = await import('@agentoctopus/skills');
    vi.mocked(loadSkillsFromDir).mockResolvedValue([
      {
        skill: {
          name: 'search-skill',
          description: 'A mock search skill',
          version: '1.0.0',
          dirPath: '/mock/skills/search',
          source: 'clawhub',
          tags: [],
          instructions: 'Mock instructions',
          frontmatter: {},
        },
        frontmatter: {
          name: 'search-skill',
          description: 'A mock search skill',
          version: '1.0.0',
          adapter: 'subprocess',
          rating: 4.5,
          tags: [],
        },
        metadata: { always: false },
        invocation: { userInvocable: true, disableModelInvocation: false },
        routingScore: undefined,
      },
    ]);

    // mock readFileSync for ratings.json
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (path.toString().includes('ratings.json')) {
        return JSON.stringify({});
      }
      return '{}';
    });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 0 } as any);

    const registry = new SkillRegistry('/mock/skills', '/mock/ratings.json');
    await registry.load();

    const skills = registry.getAll();
    expect(skills.length).toBe(1);
    expect(skills[0].manifest.name).toBe('search-skill');
    expect(skills[0].dirPath).toBe('/mock/skills/search');
    expect(skills[0].rating).toBe(4.5);
  });

  it('search correctly filters skills by name or tag', async () => {
    vi.mocked(glob).mockResolvedValue([]);
    const { loadSkillsFromDir } = await import('@agentoctopus/skills');
    vi.mocked(loadSkillsFromDir).mockResolvedValue([
      {
        skill: {
          name: 'apple-skill',
          description: 'A skill for apples',
          version: '1.0.0',
          dirPath: '/mock/skills/1',
          source: 'clawhub',
          tags: [],
          instructions: 'apples rules',
          frontmatter: {},
        },
        frontmatter: {
          name: 'apple-skill',
          description: 'A skill for apples',
          version: '1.0.0',
          adapter: 'http',
          tags: ['fruit'],
        },
        metadata: { always: false },
        invocation: { userInvocable: true, disableModelInvocation: false },
        routingScore: undefined,
      },
      {
        skill: {
          name: 'banana-skill',
          description: 'A skill for bananas',
          version: '1.0.0',
          dirPath: '/mock/skills/2',
          source: 'clawhub',
          tags: [],
          instructions: 'bananas rule',
          frontmatter: {},
        },
        frontmatter: {
          name: 'banana-skill',
          description: 'A skill for bananas',
          version: '1.0.0',
          adapter: 'http',
          tags: ['yellow', 'fruit'],
        },
        metadata: { always: false },
        invocation: { userInvocable: true, disableModelInvocation: false },
        routingScore: undefined,
      },
    ]);

    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (path.toString().includes('ratings.json')) return JSON.stringify({});
      return '{}';
    });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 0 } as any);

    const registry = new SkillRegistry('/mock/skills', '/mock/ratings.json');
    await registry.load();

    const fruitMatch = registry.search('fruit');
    expect(fruitMatch.length).toBe(2);

    const yellowMatch = registry.search('yellow');
    expect(yellowMatch.length).toBe(1);
    expect(yellowMatch[0].manifest.name).toBe('banana-skill');
  });

  it('records feedback using the underlying store', async () => {
    vi.mocked(glob).mockResolvedValue([]);
    const { loadSkillsFromDir } = await import('@agentoctopus/skills');
    vi.mocked(loadSkillsFromDir).mockResolvedValue([
      {
        skill: {
          name: 'search-skill',
          description: 'description',
          version: '1.0.0',
          dirPath: '/mock/skills/search',
          source: 'clawhub',
          tags: [],
          instructions: '',
          frontmatter: {},
        },
        frontmatter: {
          name: 'search-skill',
          description: 'description',
          version: '1.0.0',
          adapter: 'subprocess',
          rating: 4.5,
          tags: [],
        },
        metadata: { always: false },
        invocation: { userInvocable: true, disableModelInvocation: false },
        routingScore: undefined,
      },
    ]);

    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (path.toString().includes('ratings.json')) {
        return JSON.stringify({
          'search-skill': { skillName: 'search-skill', dimensions: { quality: 4.6, completion: 1, reliability: 1, latency: 1, tokenCost: 1 }, invocations: 0, recentFeedback: [] }
        });
      }
      return '{}';
    });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 0 } as any);

    const registry = new SkillRegistry('/mock/skills', '/mock/ratings.json');
    await registry.load();

    registry.recordFeedback('search-skill', true);

    const skill = registry.getByName('search-skill');
    expect(skill?.rating).toBeCloseTo(4.7);

    expect(fs.writeFileSync).toHaveBeenCalled();
  });
});
