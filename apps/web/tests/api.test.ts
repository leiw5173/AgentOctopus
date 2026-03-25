import { describe, it, expect, vi } from 'vitest';
import { POST as askPost } from '../src/app/api/ask/route.js';
import { POST as feedbackPost } from '../src/app/api/feedback/route.js';

// Mock @agentoctopus/core
vi.mock('@agentoctopus/core', () => ({
  Router: vi.fn().mockImplementation(() => ({
    buildIndex: vi.fn(),
    route: vi.fn().mockResolvedValue([{
      skill: { manifest: { name: 'test-skill' }, rating: 5 },
      score: 0.99
    }])
  })),
  Executor: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({
      skill: { manifest: { name: 'test-skill' }, rating: 5 },
      adapterResult: { success: true },
      formattedOutput: 'mock API output'
    })
  }))
}));

// Mock @agentoctopus/registry
vi.mock('@agentoctopus/registry', () => ({
  SkillRegistry: vi.fn().mockImplementation(() => ({
    load: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    getByName: vi.fn().mockImplementation((name: string) =>
      name === 'test-skill' ? { manifest: { name: 'test-skill' }, rating: 4.6 } : undefined
    ),
    recordFeedback: vi.fn()
  }))
}));

// ── /api/ask ────────────────────────────────────────────────────────────────

describe('POST /api/ask', () => {
  it('returns 400 if query is missing', async () => {
    const req = new Request('http://localhost:3000/api/ask', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const response = await askPost(req);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Query is missing');
  });

  it('routes and executes query returning success payload', async () => {
    const req = new Request('http://localhost:3000/api/ask', {
      method: 'POST',
      body: JSON.stringify({ query: 'hello world' }),
    });
    const response = await askPost(req);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.skill).toBe('test-skill');
    expect(data.confidence).toBe(0.99);
    expect(data.response).toBe('mock API output');
  });
});

// ── /api/feedback ────────────────────────────────────────────────────────────

describe('POST /api/feedback', () => {
  it('returns 400 if skillName is missing', async () => {
    const req = new Request('http://localhost:3000/api/feedback', {
      method: 'POST',
      body: JSON.stringify({ positive: true }),
    });
    const response = await feedbackPost(req);
    expect(response.status).toBe(400);
  });

  it('returns 400 if positive is missing', async () => {
    const req = new Request('http://localhost:3000/api/feedback', {
      method: 'POST',
      body: JSON.stringify({ skillName: 'test-skill' }),
    });
    const response = await feedbackPost(req);
    expect(response.status).toBe(400);
  });

  it('returns 404 for unknown skill', async () => {
    const req = new Request('http://localhost:3000/api/feedback', {
      method: 'POST',
      body: JSON.stringify({ skillName: 'unknown-skill', positive: true }),
    });
    const response = await feedbackPost(req);
    expect(response.status).toBe(404);
  });

  it('records positive feedback and returns updated rating', async () => {
    const req = new Request('http://localhost:3000/api/feedback', {
      method: 'POST',
      body: JSON.stringify({ skillName: 'test-skill', positive: true, comment: 'great!' }),
    });
    const response = await feedbackPost(req);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.skillName).toBe('test-skill');
    expect(data.newRating).toBeDefined();
  });
});
