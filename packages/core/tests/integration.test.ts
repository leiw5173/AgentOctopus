import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router } from '../src/router.js';
import { Executor } from '../src/executor.js';
import { SkillRegistry } from '@octopus/registry';
import { SubprocessAdapter } from '@octopus/adapters';

vi.mock('@octopus/adapters', () => {
  return {
    HttpAdapter: vi.fn(),
    McpAdapter: vi.fn(),
    SubprocessAdapter: vi.fn().mockImplementation(() => ({
      invoke: vi.fn().mockResolvedValue({ success: true, rawText: 'translated string' }),
    })),
  };
});

// Mock LLM layer
vi.mock('../src/llm-client.js', () => {
  return {
    createChatClient: () => ({
      chat: async () => 'test-skill', // ALWAYS select test-skill
    }),
    createEmbedClient: () => ({
      embed: async () => [0, 0, 0], // dummy vectors
    }),
    skillToText: () => 'dummy text',
  };
});

describe('Integration: Registry -> Router -> Executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('end-to-end routing and execution', async () => {
    const registry = new SkillRegistry('/mock/path', '/mock/rating');
    
    // Manually inject a skill bypassing fs
    const mockSkill = {
      manifest: { name: 'test-skill', description: 'desc', adapter: 'subprocess', tags: [], version: '1', hosting: 'local', auth: 'none', rating: 4, invocations: 0, enabled: true, llm_powered: false },
      instructions: '',
      dirPath: '/dummy',
      rating: 4.0
    };
    
    // We can inject using standard Map or spy on getAll
    vi.spyOn(registry, 'getAll').mockReturnValue([mockSkill as any]);
    vi.spyOn(registry, 'getByName').mockReturnValue(mockSkill as any);
    vi.spyOn(registry, 'recordInvocation').mockImplementation(() => {});

    // Initialize Router
    const router = new Router({ provider: 'openai', model: 'gpt-4o' }, { provider: 'openai', model: 'text-embedding-3-small' });
    await router.buildIndex(registry.getAll());

    // Route the query
    const routes = await router.route('translate helloworld');
    expect(routes.length).toBeGreaterThan(0);
    expect(routes[0].skill.manifest.name).toBe('test-skill');

    // Execute
    const executor = new Executor(registry);
    const execution = await executor.execute(routes[0].skill, { query: 'translate helloworld' });
    
    expect(execution.formattedOutput).toBe('translated string');
    expect(execution.skill.manifest.adapter).toBe('subprocess');
    expect(registry.recordInvocation).toHaveBeenCalledWith('test-skill');
  });
});
