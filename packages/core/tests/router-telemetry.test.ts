import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router } from '../src/router.js';
import type { LoadedSkill } from '@agentoctopus/registry';
import type { LLMConfig } from '../src/llm-client.js';
import type { TelemetryEvent, TelemetrySink } from '../src/execution-context.js';

// Mock the LLM client module — same pattern as router.test.ts.
// The chat mock returns a short intent phrase (so intentSource === 'llm')
// on the first call (intent extraction) and 'weather' on rerank calls.
vi.mock('../src/llm-client.js', () => {
  return {
    createChatClient: vi.fn(() => ({
      chat: vi.fn(async (_system: string, user: string) => {
        if (user.includes('Candidates:')) return 'weather';
        // Intent-extraction call: return a short phrase (must be < query.length)
        return 'get weather';
      }),
    })),
    createEmbedClient: vi.fn(() => ({
      embed: async (text: string) => {
        // Deterministic dummy embeddings: 'weather' text → strong weather vector
        if (text.toLowerCase().includes('weather')) return [1, 0, 0];
        if (text.toLowerCase().includes('translate')) return [0, 1, 0];
        return [0, 0, 1];
      },
    })),
    skillToText: (s: LoadedSkill) => `${s.manifest.name} ${s.manifest.description}`,
  };
});

function makeSkill(name: string, description: string, rating = 4.0): LoadedSkill {
  return {
    manifest: {
      name,
      description,
      tags: [],
      version: '1.0.0',
      adapter: 'http' as const,
      hosting: 'cloud' as const,
      auth: 'none' as const,
      rating,
      invocations: 0,
      enabled: true,
      llm_powered: false,
    },
    rating,
    dirPath: '/fake',
    instructions: description,
  };
}

const chatConfig: LLMConfig = { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'test-key' };
const embedConfig: LLMConfig = { provider: 'openai', model: 'text-embedding-3-small', apiKey: 'test-key' };

class CollectingSink implements TelemetrySink {
  events: TelemetryEvent[] = [];
  emit(event: TelemetryEvent): void {
    this.events.push(event);
  }
}

function routingEvents(sink: CollectingSink) {
  return sink.events.filter(e => e.kind === 'routing.completed');
}

describe('Router — routing.completed telemetry', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Restore the default chat behavior after tests that override the mock —
    // mockReturnValue persists across clearAllMocks, so re-establish it here.
    const { createChatClient } = await import('../src/llm-client.js');
    vi.mocked(createChatClient).mockReturnValue({
      chat: vi.fn(async (_system: string, user: string) => {
        if (user.includes('Candidates:')) return 'weather';
        return 'get weather';
      }),
    } as any);
  });

  it('emits exactly one routing.completed with LLM-extracted intent source', async () => {
    const sink = new CollectingSink();
    const router = new Router(chatConfig, embedConfig, sink);
    const skills = [
      makeSkill('weather', 'Gets weather forecasts'),
      makeSkill('translation', 'Translates text'),
    ];
    await router.buildIndex(skills);

    const results = await router.route('what is the weather in Tokyo today', 20, {
      execContext: { traceId: 'oct-e2e-x' },
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.skill.manifest.name).toBe('weather');

    const events = routingEvents(sink);
    expect(events).toHaveLength(1);

    const ev = events[0] as Extract<TelemetryEvent, { kind: 'routing.completed' }>;
    expect(ev.traceId).toBe('oct-e2e-x');
    // The chat stub returns 'get weather' (< query length) → LLM intent used
    expect(ev.intentSource).toBe('llm');
    expect(ev.intentExtractionSucceeded).toBe(true);
    expect(ev.intent).toBe('get weather');
    expect(ev.candidatesConsidered).toBeGreaterThan(0);
    expect(ev.selectionMethod).toBe('reranker');
    expect(ev.selected).toBe('weather');
    expect(ev.selectedRawScore).not.toBeNull();
    expect(ev.normalizedConfidence).not.toBeNull();
    expect(ev.selectedCandidateRank).not.toBeNull();
    // 'weather' has the highest raw score (its embedding matches the query embedding)
    const sorted = ev.candidates.slice().sort((a, b) => b.rawScore - a.rawScore);
    expect(sorted[0]?.name).toBe('weather');
    expect(ev.selectedCandidateRank).toBe(0);
    expect(Array.isArray(ev.candidates)).toBe(true);
    expect(ev.candidates.length).toBeGreaterThan(0);
    for (const c of ev.candidates) {
      expect(typeof c.name).toBe('string');
      expect(typeof c.rawScore).toBe('number');
    }
    // The winning candidate's rawScore matches selectedRawScore
    const winner = ev.candidates.find(c => c.name === 'weather');
    expect(winner?.rawScore).toBe(ev.selectedRawScore);
  });

  it('emits routing.completed with original-query-fallback when intent extraction fails', async () => {
    const { createChatClient } = await import('../src/llm-client.js');
    // First chat call (intent extraction) returns the whole query → not used;
    // rerank call returns 'weather'.
    vi.mocked(createChatClient).mockReturnValue({
      chat: vi.fn(async (_system: string, user: string) => {
        if (user.includes('Candidates:')) return 'weather';
        return 'what is the weather in Tokyo today'; // equals query → fallback
      }),
    } as any);

    const sink = new CollectingSink();
    const router = new Router(chatConfig, embedConfig, sink);
    await router.buildIndex([makeSkill('weather', 'Gets weather forecasts')]);

    await router.route('what is the weather in Tokyo today', 20, {
      execContext: { traceId: 'oct-e2e-y' },
    });

    const events = routingEvents(sink);
    expect(events).toHaveLength(1);
    const ev = events[0] as Extract<TelemetryEvent, { kind: 'routing.completed' }>;
    expect(ev.intentSource).toBe('original-query-fallback');
    expect(ev.intentExtractionSucceeded).toBe(false);
    expect(ev.selectionMethod).toBe('reranker');
    expect(ev.selected).toBe('weather');
  });

  it('emits routing.completed with score-fallback when the reranker throws', async () => {
    const { createChatClient } = await import('../src/llm-client.js');
    vi.mocked(createChatClient).mockReturnValue({
      chat: vi.fn(async (_system: string, user: string) => {
        if (user.includes('Candidates:')) throw new Error('reranker unavailable');
        return 'get weather';
      }),
    } as any);

    const sink = new CollectingSink();
    const router = new Router(chatConfig, embedConfig, sink);
    await router.buildIndex([makeSkill('weather', 'Gets weather forecasts')]);

    const results = await router.route('what is the weather in Tokyo today', 20, {
      execContext: { traceId: 'oct-e2e-z' },
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.reason).toContain('embedding fallback');

    const events = routingEvents(sink);
    expect(events).toHaveLength(1);
    const ev = events[0] as Extract<TelemetryEvent, { kind: 'routing.completed' }>;
    expect(ev.selectionMethod).toBe('score-fallback');
    expect(ev.selected).toBe('weather');
    // Score-fallback picks ranked[0] → rank 0
    expect(ev.selectedCandidateRank).toBe(0);
    expect(ev.selectedRawScore).toBe(results[0]!.score);
    expect(ev.normalizedConfidence).toBe(results[0]!.confidence);
  });

  it('emits routing.completed with null selected when reranker returns none', async () => {
    const { createChatClient } = await import('../src/llm-client.js');
    vi.mocked(createChatClient).mockReturnValue({
      chat: vi.fn(async (_system: string, user: string) => {
        if (user.includes('Candidates:')) return 'none';
        return 'get weather';
      }),
    } as any);

    const sink = new CollectingSink();
    const router = new Router(chatConfig, embedConfig, sink);
    await router.buildIndex([makeSkill('weather', 'Gets weather forecasts')]);

    const results = await router.route('what is the weather in Tokyo today', 20, {
      execContext: { traceId: 'oct-e2e-none' },
    });

    expect(results).toEqual([]);

    const events = routingEvents(sink);
    expect(events).toHaveLength(1);
    const ev = events[0] as Extract<TelemetryEvent, { kind: 'routing.completed' }>;
    expect(ev.selected).toBeNull();
    expect(ev.selectedRawScore).toBeNull();
    expect(ev.normalizedConfidence).toBeNull();
    expect(ev.selectedCandidateRank).toBeNull();
    expect(ev.selectionMethod).toBe('reranker');
    expect(ev.candidatesConsidered).toBeGreaterThan(0);
  });

  it('emits routing.completed on the empty-index early return path', async () => {
    const sink = new CollectingSink();
    const router = new Router(chatConfig, embedConfig, sink);
    await router.buildIndex([]);

    const results = await router.route('anything', 20, {
      execContext: { traceId: 'oct-e2e-empty' },
    });

    expect(results).toEqual([]);
    const events = routingEvents(sink);
    expect(events).toHaveLength(1);
    const ev = events[0] as Extract<TelemetryEvent, { kind: 'routing.completed' }>;
    expect(ev.selected).toBeNull();
    expect(ev.candidatesConsidered).toBe(0);
    expect(ev.candidates).toEqual([]);
    expect(ev.traceId).toBe('oct-e2e-empty');
  });

  it('routing behavior is identical with and without a sink attached', async () => {
    const skills = [
      makeSkill('weather', 'Gets weather forecasts'),
      makeSkill('translation', 'Translates text'),
    ];

    const sink = new CollectingSink();
    const withSink = new Router(chatConfig, embedConfig, sink);
    await withSink.buildIndex(skills);
    const resultsWith = await withSink.route('what is the weather in Tokyo today');

    const withoutSink = new Router(chatConfig, embedConfig);
    await withoutSink.buildIndex(skills);
    const resultsWithout = await withoutSink.route('what is the weather in Tokyo today');

    expect(resultsWith.map(r => r.skill.manifest.name)).toEqual(resultsWithout.map(r => r.skill.manifest.name));
    expect(resultsWith.map(r => r.score)).toEqual(resultsWithout.map(r => r.score));
    expect(resultsWith.map(r => r.confidence)).toEqual(resultsWithout.map(r => r.confidence));
    expect(resultsWith.map(r => r.reason)).toEqual(resultsWithout.map(r => r.reason));
  });

  it('a throwing sink does not break routing', async () => {
    const throwingSink: TelemetrySink = {
      emit() {
        throw new Error('sink exploded');
      },
    };
    const router = new Router(chatConfig, embedConfig, throwingSink);
    await router.buildIndex([makeSkill('weather', 'Gets weather forecasts')]);

    const results = await router.route('what is the weather in Tokyo today');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.skill.manifest.name).toBe('weather');
  });
});
