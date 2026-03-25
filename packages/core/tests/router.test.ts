import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router } from '../src/router.js';
import type { LoadedSkill } from '@octopus/registry';

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
});
