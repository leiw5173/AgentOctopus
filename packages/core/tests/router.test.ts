import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router } from '../src/router.js';
import type { LoadedSkill } from '@agentoctopus/registry';
import type { LLMConfig } from '../src/llm-client.js';

// Mock LLM client logic
vi.mock('../src/llm-client.js', () => {
  return {
    createChatClient: vi.fn(() => ({
      chat: vi.fn(async () => 'translation'),
    })),
    createEmbedClient: vi.fn(() => ({
      embed: async (text: string) => {
        // Return dummy embeddings (1s for 'translate', 0s for others)
        if (text.toLowerCase().includes('translate')) return [1, 1, 1];
        if (text.toLowerCase().includes('search')) return [0, 1, 0];
        return [0, 0, 0];
      },
    })),
    skillToText: (s: LoadedSkill) => `${s.manifest.name} ${s.manifest.description}`
  };
});

describe('Router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes query to the best skill using mock vector sim', async () => {
    const config = { provider: 'openai' as const, model: 'gpt-4o' };
    const router = new Router(config, config);
    
    const mockSkills: LoadedSkill[] = [
      {
        manifest: { name: 'translation', description: 'Translates text', tags: [], version: '1', adapter: 'http', hosting: 'cloud', auth: 'none', rating: 4, invocations: 0, enabled: true, llm_powered: false },
        instructions: '', dirPath: '', rating: 4
      },
      {
        manifest: { name: 'web-search', description: 'Searches the web', tags: [], version: '1', adapter: 'http', hosting: 'cloud', auth: 'none', rating: 4, invocations: 0, enabled: true, llm_powered: false },
        instructions: '', dirPath: '', rating: 4
      }
    ];

    await router.buildIndex(mockSkills);
    const result = await router.route('Can you translate hello?');
    
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]?.skill.manifest.name).toBe('translation');
  });

  it('does not route general definition questions to ip lookup', async () => {
    const config = { provider: 'openai' as const, model: 'gpt-4o' };
    const router = new Router(config, config);

    const mockSkills: LoadedSkill[] = [
      {
        manifest: { name: 'ip-lookup', description: 'Looks up IP addresses and domains', tags: ['ip', 'dns'], version: '1', adapter: 'http', hosting: 'cloud', auth: 'none', rating: 4.6, invocations: 0, enabled: true, llm_powered: false },
        instructions: '', dirPath: '', rating: 4.6
      },
      {
        manifest: { name: 'weather', description: 'Gets weather forecasts', tags: ['weather'], version: '1', adapter: 'http', hosting: 'cloud', auth: 'none', rating: 4.8, invocations: 0, enabled: true, llm_powered: false },
        instructions: '', dirPath: '', rating: 4.8
      }
    ];

    await router.buildIndex(mockSkills);
    const result = await router.route('what is llm');

    expect(result).toEqual([]);
  });

  it('treats explanatory reranker output containing none as no match', async () => {
    const { createChatClient } = await import('../src/llm-client.js');
    vi.mocked(createChatClient).mockReturnValue({
      chat: async () => 'This is a general knowledge question, so none.',
    } as any);

    const config = { provider: 'openai' as const, model: 'gpt-4o' };
    const router = new Router(config, config);

    const mockSkills: LoadedSkill[] = [
      {
        manifest: { name: 'ip-lookup', description: 'Looks up IP addresses and domains', tags: ['ip', 'dns'], version: '1', adapter: 'http', hosting: 'cloud', auth: 'none', rating: 4.6, invocations: 0, enabled: true, llm_powered: false },
        instructions: '', dirPath: '', rating: 4.6
      }
    ];

    await router.buildIndex(mockSkills);
    const result = await router.route('what is llm');

    expect(result).toEqual([]);
  });

  it('accepts debug option in buildIndex and route without throwing', async () => {
    const { createChatClient } = await import('../src/llm-client.js');
    vi.mocked(createChatClient).mockReturnValue({
      chat: vi.fn(async () => 'translation'),
    } as any);

    const config = { provider: 'openai' as const, model: 'gpt-4o' };
    const router = new Router(config, config);

    const mockSkills: LoadedSkill[] = [
      {
        manifest: { name: 'translation', description: 'Translates text', tags: [], version: '1', adapter: 'http', hosting: 'cloud', auth: 'none', rating: 4, invocations: 0, enabled: true, llm_powered: false },
        instructions: '', dirPath: '', rating: 4
      },
    ];

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    await router.buildIndex(mockSkills, { debug: true });
    const result = await router.route('translate hello', 20, { debug: true });

    spy.mockRestore();

    expect(writes.some(w => w.includes('[debug]'))).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Helper shared by the LLM-only mode tests
// ---------------------------------------------------------------------------
function makeLLMOnlySkill(name: string, description: string): LoadedSkill {
  return {
    manifest: {
      name,
      description,
      tags: [],
      version: '1.0.0',
      adapter: 'http' as const,
      hosting: 'cloud' as const,
      auth: 'none' as const,
      rating: 4.0,
      invocations: 0,
      enabled: true,
      llm_powered: false,
    },
    rating: 4.0,
    dirPath: '/fake',
    instructions: description,
  };
}

const chatConfig: LLMConfig = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  apiKey: 'test-key',
};

describe('Router — LLM-only mode (no embedConfig)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts undefined embedConfig without throwing', () => {
    expect(() => new Router(chatConfig)).not.toThrow();
    expect(() => new Router(chatConfig, undefined)).not.toThrow();
  });

  it('buildIndex stores all skills with empty embeddings when no embedClient', async () => {
    const router = new Router(chatConfig);
    const skills = [
      makeLLMOnlySkill('weather', 'Get the weather'),
      makeLLMOnlySkill('translation', 'Translate text'),
    ];
    // Should not throw even with no embedClient
    await expect(router.buildIndex(skills)).resolves.toBeUndefined();
  });

  it('route() uses all eligible skills as candidates in LLM-only mode', async () => {
    const router = new Router(chatConfig);
    const skills = [
      makeLLMOnlySkill('weather', 'Get the weather forecast'),
      makeLLMOnlySkill('translation', 'Translate text to another language'),
    ];
    await router.buildIndex(skills);

    // Override the chatClient.chat to return 'weather'
    const chatSpy = vi.spyOn((router as any).chatClient, 'chat').mockResolvedValue('weather');

    const results = await router.route('what is the weather in Tokyo');
    expect(chatSpy).toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0].skill.manifest.name).toBe('weather');
  });

  it('route() returns [] when LLM re-rank returns none', async () => {
    const router = new Router(chatConfig);
    const skills = [makeLLMOnlySkill('weather', 'Get the weather forecast')];
    await router.buildIndex(skills);

    vi.spyOn((router as any).chatClient, 'chat').mockResolvedValue('none');

    const results = await router.route('hello, how are you');
    expect(results).toHaveLength(0);
  });

  it('route() returns [] when index is empty', async () => {
    const router = new Router(chatConfig);
    await router.buildIndex([]);
    const results = await router.route('translate hello');
    expect(results).toHaveLength(0);
  });
});

describe('penalizeUnconfiguredSkills', () => {
  it('reduces score by 0.25 for a skill with a missing required env var', () => {
    delete process.env.PAID_TEST_KEY_XYZ_UNIQUE;

    const paidSkill = {
      manifest: {
        name: 'paid-skill',
        description: 'paid',
        adapter: 'http' as const,
        endpoint: 'https://paid.example.com/api',
        credentials: [{ key: 'PAID_TEST_KEY_XYZ_UNIQUE', label: 'Get at https://paid.example.com', required: true }],
        metadata: {},
      },
      dirPath: '/tmp/paid',
    };

    const freeSkill = {
      manifest: {
        name: 'free-skill',
        description: 'free',
        adapter: 'http' as const,
        endpoint: 'https://free.example.com/api',
        credentials: [],
        metadata: {},
      },
      dirPath: '/tmp/free',
    };

    // Access private method via type cast
    const router = new Router({ provider: 'openai', model: 'gpt-4o', apiKey: 'test' });
    const penalized = (router as any).penalizeUnconfiguredSkills([
      { skill: freeSkill, score: 0.8 },
      { skill: paidSkill, score: 0.8 },
    ]);

    const free = penalized.find((e: any) => e.skill.manifest.name === 'free-skill');
    const paid = penalized.find((e: any) => e.skill.manifest.name === 'paid-skill');

    expect(free.score).toBe(0.8);
    expect(paid.score).toBeCloseTo(0.55);
    expect(paid.score).toBeLessThan(free.score);
  });

  it('does not penalize a skill whose required env var IS set', () => {
    process.env.SET_TEST_KEY_XYZ_UNIQUE = 'my-value';
    try {
      const configuredSkill = {
        manifest: {
          name: 'configured-skill',
          description: 'configured',
          adapter: 'http' as const,
          credentials: [{ key: 'SET_TEST_KEY_XYZ_UNIQUE', required: true }],
          metadata: {},
        },
        dirPath: '/tmp',
      };

      const router = new Router({ provider: 'openai', model: 'gpt-4o', apiKey: 'test' });
      const penalized = (router as any).penalizeUnconfiguredSkills([
        { skill: configuredSkill, score: 0.9 },
      ]);

      expect(penalized[0].score).toBe(0.9);
    } finally {
      delete process.env.SET_TEST_KEY_XYZ_UNIQUE;
    }
  });
});
