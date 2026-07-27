/**
 * HttpAdapter → sandbox convergence (Plan 5 Task 4, matrix rows:
 * "HttpAdapter performs request from sandbox, not host fetch" + "explicit
 * manifest endpoint flow converted to sandbox HTTP invocation").
 *
 * Behavioral: the adapter serializes {method,url,headers,body} into
 * OCTOPUS_INPUT and runs the trusted in-sandbox node HTTP runner via
 * `context.sandbox.run` — it NEVER host-fetches and NEVER reads process.env
 * API keys (credential injection is the egress proxy's job).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { LoadedSkill } from '@agentoctopus/registry';
import type {
  AdapterInvocationContext,
  BoundSandboxExecutionPort,
  SandboxCommandRequest,
  SandboxRunOutput,
} from '../src/adapter.js';
import { HttpAdapter } from '../src/http-adapter.js';

class RecordingPort implements BoundSandboxExecutionPort {
  runCalls: SandboxCommandRequest[] = [];
  runResult: SandboxRunOutput = {
    success: true,
    rawText: JSON.stringify({ ok: true, status: 200, body: '{"result":"ok"}' }),
    isolationLevel: 'full',
    backend: 'docker',
  };

  async run(input: SandboxCommandRequest): Promise<SandboxRunOutput> {
    this.runCalls.push(input);
    return this.runResult;
  }

  async spawn(): Promise<never> {
    throw new Error('spawn not used by HttpAdapter');
  }
}

function makeContext(port: RecordingPort, payload: unknown): AdapterInvocationContext {
  return { sandbox: port, payload, timeoutMs: 5000 };
}

let skillDir: string;
function makeSkill(endpoint: string): LoadedSkill {
  skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oct-http-skill-'));
  return {
    dirPath: skillDir,
    manifest: { name: 'test-http', adapter: 'http', endpoint, credentials: [] },
  } as unknown as LoadedSkill;
}

describe('HttpAdapter (sandbox convergence)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (skillDir) fs.rmSync(skillDir, { recursive: true, force: true });
  });

  it('serializes the request into OCTOPUS_INPUT and runs the in-sandbox node runner', async () => {
    const skill = makeSkill('https://api.example.com/v1/do');
    const port = new RecordingPort();
    const adapter = new HttpAdapter();

    const result = await adapter.invoke(
      { skill, input: { query: 'hi' } },
      makeContext(port, { query: 'hi' }),
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ result: 'ok' });

    expect(port.runCalls).toHaveLength(1);
    const call = port.runCalls[0]!;
    // Trusted in-sandbox node runner via -e.
    expect(call.command[0]).toBe('node');
    expect(call.command[1]).toBe('-e');
    expect(typeof call.command[2]).toBe('string');
    // Request rides in the payload (→ OCTOPUS_INPUT).
    const req = call.invocation?.payload as { method: string; url: string; headers: Record<string, string>; body: string };
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/do');
    expect(req.body).toBe(JSON.stringify({ query: 'hi' }));
    // No host fetch.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never injects process.env API keys into the request headers', async () => {
    process.env.SKILL_TEST_HTTP_API_KEY = 'secret-should-not-leak';
    try {
      const skill = makeSkill('https://api.example.com/v1/do');
      (skill.manifest as any).auth = 'api_key';
      const port = new RecordingPort();
      const adapter = new HttpAdapter();

      await adapter.invoke({ skill, input: {} }, makeContext(port, {}));

      const req = port.runCalls[0]!.invocation?.payload as { headers: Record<string, string> };
      expect(req.headers['Authorization']).toBeUndefined();
      expect(JSON.stringify(req)).not.toContain('secret-should-not-leak');
    } finally {
      delete process.env.SKILL_TEST_HTTP_API_KEY;
    }
  });

  it('does not reach a local HTTP server when the sandbox denies (proxy blocks before any socket)', async () => {
    // Local server records any hit. The adapter must not host-fetch, so the
    // server must receive NOTHING; the sandbox (here a recording fake standing
    // in for a deny-all proxy session) returns a policy error.
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"reached":true}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;

    try {
      const skill = makeSkill(`http://127.0.0.1:${port}/endpoint`);
      const recPort = new RecordingPort();
      // Simulate a deny-all egress policy: the in-sandbox runner's envelope
      // reports failure (proxy refused before any upstream socket).
      recPort.runResult = {
        success: true,
        rawText: JSON.stringify({ ok: false, status: 0, body: 'egress denied by policy' }),
        isolationLevel: 'full',
        backend: 'docker',
      };
      const adapter = new HttpAdapter();

      const result = await adapter.invoke({ skill, input: {} }, makeContext(recPort, {}));

      expect(result.success).toBe(false);
      expect(hits).toBe(0); // local server never saw a request
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('returns an error result when the skill has no endpoint (no sandbox call)', async () => {
    skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oct-http-noep-'));
    const skill = {
      dirPath: skillDir,
      manifest: { name: 'no-endpoint', adapter: 'http', credentials: [] },
    } as unknown as LoadedSkill;
    const port = new RecordingPort();
    const adapter = new HttpAdapter();

    const result = await adapter.invoke({ skill, input: {} }, makeContext(port, {}));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no endpoint/i);
    expect(port.runCalls).toHaveLength(0);
  });

  it('source guard: http adapter performs no host fetch/axios/http.request', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'http-adapter.ts'),
      'utf-8',
    );
    expect(src).not.toMatch(/\bfetch\s*\(|axios\.|http\.request|https\.request/);
  });
});
