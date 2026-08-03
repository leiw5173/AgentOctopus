/**
 * Agent-protocol debug-telemetry integration tests (T3.7).
 *
 * Asserts the /ask handler:
 *   - extracts `[trace: oct-e2e-<uuid>]` from the query and strips it before
 *     routing/execution/session,
 *   - builds a per-request ExecutionContext threaded into Router/Executor,
 *   - emits EXACTLY ONE terminal event per request (including the no-route
 *     path that never reaches Executor),
 *   - records request-start metadata (apiKeyId, receivedAt, queryHash) on the
 *     DebugTelemetryBuffer directly (not through the shared sink),
 * and that GET /agent/debug/last-run:
 *   - 404 when debugEndpoints.enabled=false,
 *   - 403 for non-admin keys,
 *   - 200 {success:true, run:null} on an empty buffer,
 *   - 200 {success:true, run} on a hit (with query stripped unless includeQuery).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DebugTelemetryBuffer } from '../src/debug-telemetry.js';
import type { TelemetryEvent, ExecutionContext } from '@agentoctopus/core';

// The mock @agentoctopus/core module: we need a controllable getConfig, plus
// the REAL implementations of everything else agent-protocol.ts uses.
let mockDebugEndpoints = { enabled: true, includeQuery: false, bufferSize: 10 };

vi.doMock('@agentoctopus/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentoctopus/core')>();
  return {
    ...actual,
    getConfig: () => ({
      ...actual.getConfig(),
      gateway: {
        ...actual.getConfig().gateway,
        debugEndpoints: mockDebugEndpoints,
      },
    }),
  };
});

// Real auth middleware bypassed — tests attach (req as any).apiKeyEntry directly.
const ADMIN_ENTRY = { userId: 'admin-user', email: 'admin@x.com', tier: 'admin', createdAt: '', usage: { daily: 0, monthly: 0, lastDailyReset: '', lastMonthlyReset: '' }, active: true };
const FREE_ENTRY = { userId: 'free-user', email: 'free@x.com', tier: 'free', createdAt: '', usage: { daily: 0, monthly: 0, lastDailyReset: '', lastMonthlyReset: '' }, active: true };

interface EngineMocks {
  telemetryBuffer: DebugTelemetryBuffer;
  routeCalls: Array<{ query: string; opts: unknown }>;
  executeCalls: Array<{ input: unknown; opts: unknown }>;
  emitted: TelemetryEvent[];
  routeResult: unknown[];
}

function makeEngine(routeResult: unknown[] = []): EngineMocks & { engine: Record<string, unknown> } {
  const telemetryBuffer = new DebugTelemetryBuffer(10);
  const emitted: TelemetryEvent[] = [];
  // Intercept ALL buffer.record() calls so the test can observe every event
  // the engine emits — including the terminal event /ask records directly on
  // the buffer (which bypasses the shared sink by design).
  const originalRecord = telemetryBuffer.record.bind(telemetryBuffer);
  telemetryBuffer.record = (e: TelemetryEvent, ctx: { apiKeyId?: string; receivedAt?: number }) => {
    emitted.push(e);
    originalRecord(e, ctx);
  };
  const sink = { emit: (e: TelemetryEvent) => { telemetryBuffer.record(e, {}); } };
  const routeCalls: EngineMocks['routeCalls'] = [];
  const executeCalls: EngineMocks['executeCalls'] = [];

  const engine = {
    registry: {
      getAll: () => [],
      recordFeedback: vi.fn(),
      getByName: vi.fn(),
      getRatingStore: vi.fn(),
      getSkillFiles: vi.fn(),
    },
    router: {
      route: vi.fn(async (query: string, _topK: number, opts: { execContext?: ExecutionContext } = {}) => {
        routeCalls.push({ query, opts });
        // Simulate the router's own emission through the shared sink.
        if (opts.execContext?.traceId) {
          sink.emit({
            kind: 'routing.completed',
            traceId: opts.execContext.traceId,
            intent: query,
            intentSource: 'original-query-fallback',
            intentExtractionSucceeded: false,
            candidatesConsidered: 0,
            selected: null,
            selectedRawScore: null,
            normalizedConfidence: null,
            candidates: [],
            selectionMethod: 'score-fallback',
            selectedCandidateRank: null,
          });
        }
        return routeResult;
      }),
    },
    executor: {
      execute: vi.fn(async (_skill: unknown, input: unknown, opts: { execContext?: ExecutionContext } = {}) => {
        executeCalls.push({ input, opts });
        if (opts.execContext?.traceId) {
          sink.emit({
            kind: 'adapter.completed',
            traceId: opts.execContext.traceId,
            executionId: 'exec-1',
            adapterSuccess: true,
            errorCode: null,
            outputValidated: false,
            outputValidationReason: 'no validator',
          });
        }
        return {
          formattedOutput: 'hello world',
          skill: { manifest: { name: 'test-skill' } },
          adapterResult: { success: true, rawText: 'hello world' },
        };
      }),
    },
    chatClient: {
      chat: vi.fn(async () => 'general answer'),
    },
    telemetryBuffer,
    telemetrySink: sink,
  };

  return { engine, telemetryBuffer, routeCalls, executeCalls, emitted, routeResult };
}

function mockRes() {
  return {
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
}

async function makeRouter(engine: Record<string, unknown>) {
  vi.doMock('../src/engine.js', () => ({
    DIRECT_ANSWER_SYSTEM_PROMPT: 'You are a helpful assistant.',
    bootstrapEngine: vi.fn().mockResolvedValue(engine),
    resetEngine: vi.fn(),
  }));
  const { createAgentRouter } = await import('../src/agent-protocol.js');
  return createAgentRouter();
}

type RouterStack = Array<{
  route?: { path?: string; methods?: Record<string, boolean>; stack?: Array<{ handle: (req: unknown, res: unknown) => unknown }> };
}>;

function findRoute(router: unknown, path: string, method: 'get' | 'post') {
  const stack = (router as unknown as { stack: RouterStack }).stack;
  return stack.find((layer) => layer.route?.path === path && layer.route?.methods?.[method]);
}

async function callRoute(router: unknown, path: string, method: 'get' | 'post', req: Record<string, unknown>) {
  const layer = findRoute(router, path, method);
  expect(layer, `route ${method.toUpperCase()} ${path} not registered`).toBeDefined();
  const res = mockRes();
  await layer!.route!.stack![0]!.handle(req, res);
  return res;
}

beforeEach(() => {
  vi.resetModules();
  mockDebugEndpoints = { enabled: true, includeQuery: false, bufferSize: 10 };
});

describe('GET /agent/debug/last-run', () => {
  it('returns 403 for a non-admin (free) key', async () => {
    const { engine } = makeEngine();
    const router = await makeRouter(engine);
    const res = await callRoute(router, '/debug/last-run', 'get', {
      query: {},
      apiKeyEntry: FREE_ENTRY,
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 200 {success:true, run:null} on an empty buffer with an admin key', async () => {
    const { engine } = makeEngine();
    const router = await makeRouter(engine);
    const res = await callRoute(router, '/debug/last-run', 'get', {
      query: {},
      apiKeyEntry: ADMIN_ENTRY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ success: true, run: null });
  });

  it('returns 404 when debugEndpoints.enabled=false', async () => {
    mockDebugEndpoints = { enabled: false, includeQuery: false, bufferSize: 10 };
    const { engine } = makeEngine();
    const router = await makeRouter(engine);
    const res = await callRoute(router, '/debug/last-run', 'get', {
      query: {},
      apiKeyEntry: ADMIN_ENTRY,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /agent/ask telemetry', () => {
  it('extracts [trace: oct-e2e-…], strips it from routing, emits exactly one terminal, and serves the aggregated record', async () => {
    const { engine, telemetryBuffer, routeCalls, emitted } = makeEngine([]);
    const router = await makeRouter(engine);
    const traceId = 'oct-e2e-12345678-1234-1234-1234-1234567890ab';

    const askRes = await callRoute(router, '/ask', 'post', {
      body: { query: `hello world [trace: ${traceId}]`, agentId: 'test-agent' },
      apiKeyEntry: ADMIN_ENTRY,
      apiKey: 'raw-admin-key-that-must-never-appear',
    });
    expect(askRes.statusCode).toBe(200);

    // The trace marker must be stripped before routing.
    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0]!.query).toBe('hello world');
    expect(routeCalls[0]!.query).not.toContain('oct-e2e-');

    // The terminal event: exactly one, request.completed (no-route is not a failure).
    const terminals = emitted.filter((e) => e.kind === 'request.completed' || e.kind === 'request.failed');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.kind).toBe('request.completed');
    expect((terminals[0] as { traceId: string }).traceId).toBe(traceId);

    // The buffer now holds a non-pending record keyed by traceId.
    const rec = telemetryBuffer.getByRunId(traceId);
    expect(rec).not.toBeNull();
    expect(rec!.status).not.toBe('pending');
    // apiKeyId is present and is NEVER the raw key.
    expect(rec!.apiKeyId).toBeTruthy();
    expect(rec!.apiKeyId).not.toBe('raw-admin-key-that-must-never-appear');

    // The endpoint serves the same record by runId.
    const getRes = await callRoute(router, '/debug/last-run', 'get', {
      query: { runId: traceId },
      apiKeyEntry: ADMIN_ENTRY,
    });
    expect(getRes.statusCode).toBe(200);
    const body = getRes.jsonBody as { success: boolean; run: { runId: string; status: string; query?: string } };
    expect(body.success).toBe(true);
    expect(body.run.runId).toBe(traceId);
    expect(body.run.status).not.toBe('pending');
    // includeQuery=false → query stripped from the response.
    expect(body.run.query).toBeUndefined();
  });

  it('a no-route /ask (router returns []) STILL emits exactly one terminal event even though Executor never ran', async () => {
    const { engine, telemetryBuffer, executeCalls, emitted } = makeEngine([]);
    const router = await makeRouter(engine);
    const traceId = 'oct-e2e-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    await callRoute(router, '/ask', 'post', {
      body: { query: `no route here [trace: ${traceId}]`, agentId: 'test-agent' },
      apiKeyEntry: ADMIN_ENTRY,
      apiKey: 'k',
    });

    expect(executeCalls).toHaveLength(0);
    const terminals = emitted.filter((e) => e.kind === 'request.completed' || e.kind === 'request.failed');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.kind).toBe('request.completed');

    const rec = telemetryBuffer.getByRunId(traceId);
    expect(rec).not.toBeNull();
    expect(rec!.status).not.toBe('pending');
  });

  it('emits request.failed when routing throws', async () => {
    const { engine, telemetryBuffer, emitted } = makeEngine([]);
    // Force the router to throw.
    (engine.router as { route: ReturnType<typeof vi.fn> }).route.mockRejectedValueOnce(new Error('boom'));
    const router = await makeRouter(engine);
    const traceId = 'oct-e2e-00000000-0000-0000-0000-000000000000';

    const res = await callRoute(router, '/ask', 'post', {
      body: { query: `explode [trace: ${traceId}]`, agentId: 'test-agent' },
      apiKeyEntry: ADMIN_ENTRY,
      apiKey: 'k',
    });
    expect(res.statusCode).toBe(500);

    const terminals = emitted.filter((e) => e.kind === 'request.completed' || e.kind === 'request.failed');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.kind).toBe('request.failed');
    expect((terminals[0] as { reason: string }).reason).toContain('boom');

    const rec = telemetryBuffer.getByRunId(traceId);
    expect(rec!.status).toBe('failed');
  });

  it('requests WITHOUT a trace marker skip all telemetry', async () => {
    const { engine, telemetryBuffer, emitted } = makeEngine([]);
    const router = await makeRouter(engine);

    await callRoute(router, '/ask', 'post', {
      body: { query: 'plain query no trace', agentId: 'test-agent' },
      apiKeyEntry: ADMIN_ENTRY,
      apiKey: 'k',
    });

    const terminals = emitted.filter((e) => e.kind === 'request.completed' || e.kind === 'request.failed');
    expect(terminals).toHaveLength(0);
    expect(telemetryBuffer.latest()).toBeNull();
  });

  it('emits exactly ONE request.failed terminal when pre-routing session setup throws (no stuck pending record)', async () => {
    const { engine, telemetryBuffer, emitted } = makeEngine([]);
    const router = await makeRouter(engine);
    const traceId = 'oct-e2e-ffffffff-ffff-ffff-ffff-ffffffffffff';

    // Force the pre-routing session setup to throw. The /ask handler invokes
    // sessionManager.addMessage BEFORE the inner routing try/finally — this
    // path used to leak a permanently-pending record.
    const { sessionManager } = await import('../src/session.js');
    const spy = vi.spyOn(sessionManager, 'addMessage').mockImplementationOnce(() => {
      throw new Error('session store exploded');
    });

    try {
      // The handler does not catch internally — Express's default error handler
      // produces the 500. Our callRoute helper invokes the route function
      // directly, so the throw propagates to the test. We assert the terminal
      // emission even though the request errors out.
      await expect(
        callRoute(router, '/ask', 'post', {
          body: { query: `setup explode [trace: ${traceId}]`, agentId: 'test-agent' },
          apiKeyEntry: ADMIN_ENTRY,
          apiKey: 'k',
        }),
      ).rejects.toThrow('session store exploded');
    } finally {
      spy.mockRestore();
    }

    const terminals = emitted.filter((e) => e.kind === 'request.completed' || e.kind === 'request.failed');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.kind).toBe('request.failed');
    expect((terminals[0] as { reason: string }).reason).toContain('session store exploded');

    const rec = telemetryBuffer.getByRunId(traceId);
    expect(rec).not.toBeNull();
    expect(rec!.status).toBe('failed');
  });
});
