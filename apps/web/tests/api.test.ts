import { describe, it, expect, vi } from 'vitest';
import { POST } from '../src/app/api/ask/route.js';

// Deep mock of @octopus/core and @octopus/registry
vi.mock('@octopus/core', () => {
  return {
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
  };
});

vi.mock('@octopus/registry', () => {
  return {
    SkillRegistry: vi.fn().mockImplementation(() => ({
      load: vi.fn(),
      getAll: vi.fn().mockReturnValue([])
    }))
  };
});

describe('POST /api/ask', () => {
  it('returns 400 if query is missing', async () => {
    const req = new Request('http://localhost:3000/api/ask', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    
    const response = await POST(req);
    expect(response.status).toBe(400);
    
    const data = await response.json();
    expect(data.error).toBe('Query is missing');
  });

  it('routes and executes query returning success payload', async () => {
    const req = new Request('http://localhost:3000/api/ask', {
      method: 'POST',
      body: JSON.stringify({ query: 'hello world' }),
    });

    const response = await POST(req);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.skill).toBe('test-skill');
    expect(data.confidence).toBe(0.99);
    expect(data.response).toBe('mock API output');
  });
});
