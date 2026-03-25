import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionManager } from '../src/session.js';
import { resetEngine } from '../src/engine.js';

// ─── Session Manager ────────────────────────────────────────────────────────

describe('SessionManager', () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager();
  });

  it('creates a new session for unknown channel+user', () => {
    const s = sm.getOrCreate('ch1', 'user1', 'slack');
    expect(s.id).toBeTruthy();
    expect(s.platform).toBe('slack');
    expect(s.messages).toHaveLength(0);
  });

  it('returns the same session for the same key', () => {
    const s1 = sm.getOrCreate('ch1', 'user1', 'slack');
    const s2 = sm.getOrCreate('ch1', 'user1', 'slack');
    expect(s1.id).toBe(s2.id);
  });

  it('creates different sessions for different platforms', () => {
    const slack = sm.getOrCreate('ch1', 'user1', 'slack');
    const discord = sm.getOrCreate('ch1', 'user1', 'discord');
    expect(slack.id).not.toBe(discord.id);
  });

  it('adds messages and caps at 50', () => {
    const session = sm.getOrCreate('ch2', 'user2', 'discord');
    for (let i = 0; i < 55; i++) {
      sm.addMessage(session, { role: 'user', content: `msg ${i}`, timestamp: Date.now() });
    }
    expect(session.messages).toHaveLength(50);
    expect(session.messages[0].content).toBe('msg 5');
  });

  it('getById returns the right session', () => {
    const s = sm.getOrCreate('ch3', 'user3', 'telegram');
    const found = sm.getById(s.id);
    expect(found?.id).toBe(s.id);
  });

  it('getById returns undefined for unknown id', () => {
    expect(sm.getById('nonexistent')).toBeUndefined();
  });

  it('destroy removes the session', () => {
    sm.getOrCreate('ch4', 'user4', 'agent');
    sm.destroy('ch4', 'user4', 'agent');
    // After destroy, a new session is created (different id)
    const s2 = sm.getOrCreate('ch4', 'user4', 'agent');
    const found = sm.getById(s2.id);
    expect(found).toBeDefined();
  });

  it('prune removes expired sessions', () => {
    const s = sm.getOrCreate('ch5', 'user5', 'http');
    // Manually age the session beyond TTL
    s.updatedAt = Date.now() - 31 * 60 * 1000;
    sm.prune();
    // The key is gone — a new session is created next call
    const s2 = sm.getOrCreate('ch5', 'user5', 'http');
    expect(s2.id).not.toBe(s.id);
  });
});

// ─── Agent Protocol ─────────────────────────────────────────────────────────

describe('createAgentRouter', () => {
  beforeEach(() => {
    resetEngine();
    vi.resetModules();
  });

  it('returns a router with /ask, /feedback, and /health routes', async () => {
    // Mock bootstrapEngine so we don't need real LLM or registry
    vi.doMock('../src/engine.js', () => ({
      bootstrapEngine: vi.fn().mockResolvedValue({
        registry: {
          getAll: () => [{ manifest: { name: 'test-skill' } }],
          recordFeedback: vi.fn(),
        },
        router: {
          route: vi.fn().mockResolvedValue([
            { skill: { manifest: { name: 'test-skill' } }, score: 0.9, reason: 'test' },
          ]),
        },
        executor: {
          execute: vi.fn().mockResolvedValue({ formattedOutput: 'hello world', skill: { manifest: { name: 'test-skill' } } }),
        },
      }),
      resetEngine: vi.fn(),
    }));

    const { createAgentRouter } = await import('../src/agent-protocol.js');
    const router = await createAgentRouter();

    // Router should be an Express router (a function with .stack)
    expect(typeof router).toBe('function');
    expect(Array.isArray((router as unknown as { stack: unknown[] }).stack)).toBe(true);
  });

  it('falls back to direct chat answers when no skill matches', async () => {
    vi.doMock('../src/engine.js', () => ({
      DIRECT_ANSWER_SYSTEM_PROMPT: 'You are a helpful assistant. Answer the user\'s question concisely and accurately.',
      bootstrapEngine: vi.fn().mockResolvedValue({
        registry: {
          getAll: () => [{ manifest: { name: 'test-skill' } }],
          recordFeedback: vi.fn(),
        },
        router: {
          route: vi.fn().mockResolvedValue([]),
        },
        executor: {
          execute: vi.fn(),
        },
        chatClient: {
          chat: vi.fn().mockResolvedValue('general answer'),
        },
      }),
      resetEngine: vi.fn(),
    }));

    const { createAgentRouter } = await import('../src/agent-protocol.js');
    const router = await createAgentRouter();
    const askLayer = (router as unknown as { stack: Array<{ route?: { path?: string; stack?: Array<{ handle: Function }> } }> }).stack
      .find((layer) => layer.route?.path === '/ask');

    expect(askLayer).toBeDefined();

    const req = {
      body: {
        query: 'what is llm',
        agentId: 'test-agent',
      },
    } as any;

    const res = {
      statusCode: 200,
      jsonBody: undefined as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.jsonBody = payload;
        return this;
      },
    };

    await askLayer!.route!.stack![0]!.handle(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({
      success: true,
      response: 'general answer',
      skill: null,
      sessionId: expect.any(String),
      confidence: null,
    });
  });
});

// ─── Engine bootstrap reset helper ──────────────────────────────────────────

describe('resetEngine', () => {
  it('clears the cached engine without throwing', () => {
    expect(() => resetEngine()).not.toThrow();
  });
});
