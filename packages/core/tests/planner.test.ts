import { describe, it, expect, vi } from 'vitest';
import { Planner, type ExecutionPlan, type PlanStep } from '../src/planner.js';
import type { Router, RoutingResult } from '../src/router.js';
import type { Executor, ExecutionResult } from '../src/executor.js';
import type { ChatClient } from '../src/llm-client.js';
import type { LoadedSkill } from '@agentoctopus/registry';

function mockSkill(name: string): LoadedSkill {
  return {
    manifest: {
      name,
      description: `${name} skill`,
      tags: [],
      version: '1.0.0',
      adapter: 'subprocess' as const,
      hosting: 'local' as const,
      auth: 'none' as const,
      rating: 4.0,
      invocations: 0,
      enabled: true,
      llm_powered: false,
    },
    instructions: '',
    dirPath: '',
    rating: 4.0,
  };
}

function createMockChatClient(responses: string[]): ChatClient {
  let callIndex = 0;
  return {
    chat: vi.fn(async () => {
      return responses[callIndex++] || '';
    }),
  };
}

describe('Planner', () => {
  it('produces a single-step plan for simple queries', async () => {
    const chatClient = createMockChatClient([
      '{"steps": [{"id": "1", "query": "translate hello to French", "dependsOn": []}]}',
    ]);
    const router = { route: vi.fn(async () => []), buildIndex: vi.fn() } as unknown as Router;
    const executor = { execute: vi.fn() } as unknown as Executor;

    const planner = new Planner(chatClient, router, executor);
    const plan = await planner.plan('translate hello to French', [mockSkill('translation')]);

    expect(plan.isMultiHop).toBe(false);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.query).toBe('translate hello to French');
  });

  it('decomposes multi-hop queries into multiple steps', async () => {
    const chatClient = createMockChatClient([
      '{"steps": [{"id": "1", "query": "translate hello to French", "dependsOn": []}, {"id": "2", "query": "what is the weather in Paris", "dependsOn": []}]}',
    ]);
    const router = { route: vi.fn(async () => []), buildIndex: vi.fn() } as unknown as Router;
    const executor = { execute: vi.fn() } as unknown as Executor;

    const planner = new Planner(chatClient, router, executor);
    const plan = await planner.plan(
      'translate hello to French and check the weather in Paris',
      [mockSkill('translation'), mockSkill('weather')],
    );

    expect(plan.isMultiHop).toBe(true);
    expect(plan.steps).toHaveLength(2);
  });

  it('falls back to single step when LLM returns invalid JSON', async () => {
    const chatClient = createMockChatClient(['not valid json at all']);
    const router = { route: vi.fn(async () => []), buildIndex: vi.fn() } as unknown as Router;
    const executor = { execute: vi.fn() } as unknown as Executor;

    const planner = new Planner(chatClient, router, executor);
    const plan = await planner.plan('hello', []);

    expect(plan.isMultiHop).toBe(false);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.query).toBe('hello');
  });

  it('executes a single-step plan with direct LLM when no skill matches', async () => {
    const chatClient = createMockChatClient([
      '{"steps": [{"id": "1", "query": "what is 2+2", "dependsOn": []}]}',
      '4', // direct LLM answer
    ]);
    const router = { route: vi.fn(async () => []), buildIndex: vi.fn() } as unknown as Router;
    const executor = { execute: vi.fn() } as unknown as Executor;

    const planner = new Planner(chatClient, router, executor);
    const result = await planner.run('what is 2+2', []);

    expect(result.stepResults).toHaveLength(1);
    expect(result.stepResults[0]!.skill).toBeNull();
    expect(result.stepResults[0]!.output).toBe('4');
    expect(result.finalAnswer).toBe('4');
  });

  it('executes a multi-step plan and synthesizes results', async () => {
    const skill = mockSkill('translation');
    const chatClient = createMockChatClient([
      // plan response
      '{"steps": [{"id": "1", "query": "translate hello to French", "dependsOn": []}, {"id": "2", "query": "what is 2+2", "dependsOn": []}]}',
      // direct LLM answer for step 2
      '4',
      // synthesis
      'Bonjour! And 2+2 = 4.',
    ]);

    const router = {
      route: vi.fn(async (query: string) => {
        if (query.includes('translate')) {
          return [{ skill, score: 0.9, confidence: 0.86, reason: 'match' }] as RoutingResult[];
        }
        return [];
      }),
      buildIndex: vi.fn(),
    } as unknown as Router;

    const executor = {
      execute: vi.fn(async () => ({
        skill,
        adapterResult: { success: true, rawText: '{"result":"Bonjour"}' },
        formattedOutput: 'Bonjour',
      })),
    } as unknown as Executor;

    const planner = new Planner(chatClient, router, executor);
    const result = await planner.run('translate hello to French and what is 2+2', [skill]);

    expect(result.plan.isMultiHop).toBe(true);
    expect(result.stepResults).toHaveLength(2);
    expect(result.stepResults[0]!.skill).toBe('translation');
    expect(result.stepResults[0]!.output).toBe('Bonjour');
    expect(result.stepResults[1]!.skill).toBeNull();
    expect(result.stepResults[1]!.output).toBe('4');
    expect(result.finalAnswer).toBe('Bonjour! And 2+2 = 4.');
  });

  it('handles dependencies between steps', async () => {
    const chatClient = createMockChatClient([
      '{"steps": [{"id": "1", "query": "what is the capital of France", "dependsOn": []}, {"id": "2", "query": "weather in the capital", "dependsOn": ["1"]}]}',
      'Paris', // step 1 LLM answer
      'Sunny, 22°C', // step 2 LLM answer
      'The capital of France is Paris, and the weather there is sunny at 22°C.',
    ]);
    const router = { route: vi.fn(async () => []), buildIndex: vi.fn() } as unknown as Router;
    const executor = { execute: vi.fn() } as unknown as Executor;

    const planner = new Planner(chatClient, router, executor);
    const result = await planner.run(
      'what is the weather in the capital of France',
      [],
    );

    expect(result.stepResults).toHaveLength(2);
    // Step 2 should have received context from step 1
    const step2Call = (router.route as any).mock.calls.find(
      (call: any) => call[0].includes('Context from previous step'),
    );
    expect(step2Call).toBeDefined();
  });
});
