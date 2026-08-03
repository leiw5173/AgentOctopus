/**
 * Executor telemetry + injected async-timeout OutputValidator (T3.4).
 *
 * Scope (binding note from the brief): Executor emits ONLY `adapter.completed`.
 * It NEVER emits `request.completed`/`request.failed` — the gateway /ask
 * handler (T3.7) is the single terminal-event emitter because the no-route
 * fallback path never reaches Executor.
 *
 * Emission rules:
 *   - The single real-adapter return path emits exactly one `adapter.completed`
 *     AFTER the `detectHttpErrorInOutput` mutation (so `adapterSuccess` reflects
 *     the FINAL success flag — including a "successful" curl 403 flipped to
 *     failed) and BEFORE the return.
 *   - The four non-adapter early returns (credential_missing,
 *     unsupported_runtime_requirements, composed-no-composer, composed-result)
 *     do NOT emit `adapter.completed` — they never reached a real adapter.
 *   - The event NEVER carries rawText/output content. errorCode is normalized
 *     (EAI_AGAIN, ECONNREFUSED, host not granted, HTTP status substrings, else
 *     first token, else null).
 *   - outputValidated/outputValidationReason come from the injected
 *     OutputValidator (run only when adapter succeeded). When no validator is
 *     injected: outputValidated=false, reason='no validator'. When the adapter
 *     failed: outputValidated=false, reason='adapter failed'.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LoadedSkill, SkillRegistry } from '@agentoctopus/registry';
import type {
  BoundSandboxExecutionPort,
  SandboxCommandRequest,
  SandboxRunOutput,
} from '@agentoctopus/adapters';
import { Executor } from '../src/executor.js';
import type { SandboxRunner } from '../src/sandbox-runner.js';
import { runOutputValidator } from '../src/output-validator.js';
import type { ExecutionContext, TelemetryEvent, TelemetrySink } from '../src/execution-context.js';

vi.mock('../src/utils.js', () => ({
  isBinAvailable: vi.fn().mockReturnValue(true),
}));

// ---------------------------------------------------------------------------
// runOutputValidator — verbatim from the brief
// ---------------------------------------------------------------------------
describe('runOutputValidator', () => {
  it('returns ok:true when validator resolves ok', async () => {
    const r = await runOutputValidator(async () => ({ ok: true }), { success: true }, 1000);
    expect(r).toEqual({ ok: true, reason: null });
  });
  it('returns ok:false on timeout', async () => {
    const r = await runOutputValidator(() => new Promise(() => {}), { success: true }, 50);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/timeout/i);
  });
  it('returns ok:false with reason when validator reports invalid', async () => {
    const r = await runOutputValidator(async () => ({ ok: false, reason: 'missing temperature field' }), { success: true }, 1000);
    expect(r).toEqual({ ok: false, reason: 'missing temperature field' });
  });
});

// ---------------------------------------------------------------------------
// Executor adapter.completed emission
// ---------------------------------------------------------------------------

class StubPort implements BoundSandboxExecutionPort {
  runCalls: SandboxCommandRequest[] = [];
  runResult: SandboxRunOutput = {
    success: true,
    rawText: '{"result":"ok"}',
    isolationLevel: 'full',
    backend: 'docker',
    meta: { isolationLevel: 'full', backend: 'docker', degraded: false, degradationReasons: [] },
  };

  async run(input: SandboxCommandRequest): Promise<SandboxRunOutput> {
    this.runCalls.push(input);
    return this.runResult;
  }

  async spawn(): Promise<never> {
    throw new Error('spawn not used in one-shot execution');
  }
}

function makeRunner(port: StubPort): SandboxRunner {
  return { bind: () => port } as unknown as SandboxRunner;
}

function makeRegistry(instructions = ''): SkillRegistry {
  return {
    recordInvocation: vi.fn(),
    recordInvocationMetrics: vi.fn(),
    readInstructions: vi.fn().mockReturnValue(instructions),
  } as unknown as SkillRegistry;
}

class CollectingSink implements TelemetrySink {
  readonly events: TelemetryEvent[] = [];
  emit(event: TelemetryEvent): void {
    this.events.push(event);
  }
}

class ThrowingSink implements TelemetrySink {
  emit(): void {
    throw new Error('sink exploded');
  }
}

let dirs: string[] = [];
function makeDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oct-exec-tele-'));
  dirs.push(d);
  return d;
}

function subprocessSkill(): LoadedSkill {
  const dirPath = makeDir();
  fs.mkdirSync(path.join(dirPath, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dirPath, 'scripts', 'invoke.js'), '// noop');
  return {
    dirPath,
    manifest: { name: 'tele-sub', adapter: 'subprocess', credentials: [] },
  } as unknown as LoadedSkill;
}

function credentialMissingSkill(): LoadedSkill {
  const dirPath = makeDir();
  return {
    dirPath,
    manifest: {
      name: 'tele-cred',
      adapter: 'subprocess',
      credentials: [{ key: 'TELE_MISSING_API_KEY', label: 'Tele Key' }],
    },
  } as unknown as LoadedSkill;
}

afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
  delete process.env.TELE_MISSING_API_KEY;
});

describe('Executor — adapter.completed telemetry (T3.4)', () => {
  it('emits adapter.completed with adapterSuccess + validator result on a clean success', async () => {
    const port = new StubPort();
    port.runResult = {
      success: true,
      rawText: '{"result":"hello"}',
      isolationLevel: 'full',
      backend: 'docker',
      meta: { isolationLevel: 'full', backend: 'docker', degraded: false, degradationReasons: [] },
    };
    const sink = new CollectingSink();
    const execContext: ExecutionContext = { traceId: 'oct-e2e-t34', executionId: 'exec-t34-1' };
    const validator = async () => ({ ok: true });
    const executor = new Executor(
      makeRegistry(),
      undefined,
      undefined,
      makeRunner(port),
      { execContext, telemetrySink: sink, outputValidator: validator },
    );
    const skill = subprocessSkill();

    const result = await executor.execute(skill, { query: 'hi' });
    expect('adapterResult' in result && result.adapterResult.success).toBe(true);

    const events = sink.events.filter((e) => e.kind === 'adapter.completed');
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    if (ev.kind !== 'adapter.completed') throw new Error('unreachable');
    expect(ev.traceId).toBe('oct-e2e-t34');
    expect(ev.executionId).toBe('exec-t34-1');
    expect(ev.adapterSuccess).toBe(true);
    expect(ev.errorCode).toBeNull();
    expect(ev.outputValidated).toBe(true);
    expect(ev.outputValidationReason).toBeNull();
  });

  it('adapter.completed reflects the FINAL success flag when detectHttpErrorInOutput flips a "successful" curl 403', async () => {
    const port = new StubPort();
    // curl exits 0 but the body carries a 403 — detectHttpErrorInOutput must flip it.
    port.runResult = {
      success: true,
      rawText: '{"status":403,"message":"Forbidden"}',
      isolationLevel: 'full',
      backend: 'docker',
      meta: { isolationLevel: 'full', backend: 'docker', degraded: false, degradationReasons: [] },
    };
    const sink = new CollectingSink();
    const executor = new Executor(
      makeRegistry(),
      undefined,
      undefined,
      makeRunner(port),
      { execContext: { executionId: 'exec-t34-2' }, telemetrySink: sink },
    );
    const skill = subprocessSkill();

    const result = await executor.execute(skill, { query: 'hi' });
    expect('adapterResult' in result && result.adapterResult.success).toBe(false);

    const events = sink.events.filter((e) => e.kind === 'adapter.completed');
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    if (ev.kind !== 'adapter.completed') throw new Error('unreachable');
    expect(ev.adapterSuccess).toBe(false);
    expect(ev.errorCode).toBe('403');
    // Validator must NOT run on a failed adapter result.
    expect(ev.outputValidated).toBe(false);
    expect(ev.outputValidationReason).toBe('adapter failed');
  });

  it('normalizes a DNS EAI_AGAIN error from the adapter', async () => {
    const port = new StubPort();
    port.runResult = {
      success: false,
      error: 'getaddrinfo EAI_AGAIN api.example.com',
      isolationLevel: 'full',
      backend: 'docker',
      meta: { isolationLevel: 'full', backend: 'docker', degraded: false, degradationReasons: [] },
    };
    const sink = new CollectingSink();
    const executor = new Executor(
      makeRegistry(),
      undefined,
      undefined,
      makeRunner(port),
      { execContext: { executionId: 'exec-t34-3' }, telemetrySink: sink },
    );
    const skill = subprocessSkill();

    const result = await executor.execute(skill, { query: 'hi' });
    expect('adapterResult' in result && result.adapterResult.success).toBe(false);

    const events = sink.events.filter((e) => e.kind === 'adapter.completed');
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    if (ev.kind !== 'adapter.completed') throw new Error('unreachable');
    expect(ev.adapterSuccess).toBe(false);
    expect(ev.errorCode).toBe('EAI_AGAIN');
    expect(ev.outputValidated).toBe(false);
    expect(ev.outputValidationReason).toBe('adapter failed');
  });

  it('normalizes an egress host-not-granted error', async () => {
    const port = new StubPort();
    port.runResult = {
      success: false,
      error: 'egress proxy denied: host not granted by policy',
      isolationLevel: 'full',
      backend: 'docker',
      meta: { isolationLevel: 'full', backend: 'docker', degraded: false, degradationReasons: [] },
    };
    const sink = new CollectingSink();
    const executor = new Executor(
      makeRegistry(),
      undefined,
      undefined,
      makeRunner(port),
      { execContext: { executionId: 'exec-t34-4' }, telemetrySink: sink },
    );
    const skill = subprocessSkill();

    await executor.execute(skill, { query: 'hi' });

    const events = sink.events.filter((e) => e.kind === 'adapter.completed');
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    if (ev.kind !== 'adapter.completed') throw new Error('unreachable');
    expect(ev.errorCode).toBe('host not granted');
  });

  it('propagates a failing validator result onto adapter.completed', async () => {
    const port = new StubPort();
    port.runResult = {
      success: true,
      rawText: '{"result":"missing temperature"}',
      isolationLevel: 'full',
      backend: 'docker',
      meta: { isolationLevel: 'full', backend: 'docker', degraded: false, degradationReasons: [] },
    };
    const sink = new CollectingSink();
    const validator = async () => ({ ok: false, reason: 'missing temperature field' });
    const executor = new Executor(
      makeRegistry(),
      undefined,
      undefined,
      makeRunner(port),
      { execContext: { executionId: 'exec-t34-5' }, telemetrySink: sink, outputValidator: validator },
    );
    const skill = subprocessSkill();

    await executor.execute(skill, { query: 'hi' });

    const events = sink.events.filter((e) => e.kind === 'adapter.completed');
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    if (ev.kind !== 'adapter.completed') throw new Error('unreachable');
    expect(ev.adapterSuccess).toBe(true);
    expect(ev.outputValidated).toBe(false);
    expect(ev.outputValidationReason).toBe('missing temperature field');
  });

  it('never puts rawText/output content on the emitted event', async () => {
    const port = new StubPort();
    port.runResult = {
      success: true,
      rawText: '{"result":"SENSITIVE_PAYLOAD"}',
      isolationLevel: 'full',
      backend: 'docker',
      meta: { isolationLevel: 'full', backend: 'docker', degraded: false, degradationReasons: [] },
    };
    const sink = new CollectingSink();
    const executor = new Executor(
      makeRegistry(),
      undefined,
      undefined,
      makeRunner(port),
      { execContext: { executionId: 'exec-t34-6' }, telemetrySink: sink },
    );
    const skill = subprocessSkill();

    await executor.execute(skill, { query: 'hi' });

    const events = sink.events.filter((e) => e.kind === 'adapter.completed');
    expect(events).toHaveLength(1);
    const raw = JSON.stringify(events[0]!);
    expect(raw).not.toContain('SENSITIVE_PAYLOAD');
    expect(events[0]).not.toHaveProperty('rawText');
    expect(events[0]).not.toHaveProperty('output');
    expect(events[0]).not.toHaveProperty('data');
  });

  it('does NOT emit adapter.completed on the credential_missing early return', async () => {
    const port = new StubPort();
    const sink = new CollectingSink();
    const executor = new Executor(
      makeRegistry(),
      undefined,
      undefined,
      makeRunner(port),
      { execContext: { executionId: 'exec-t34-7' }, telemetrySink: sink },
    );
    const skill = credentialMissingSkill();

    const result = await executor.execute(skill, { query: 'hi' });
    expect('type' in result && result.type).toBe('credential_missing');

    // No adapter was ever reached — the port saw zero calls and no event fired.
    expect(port.runCalls).toHaveLength(0);
    expect(sink.events.filter((e) => e.kind === 'adapter.completed')).toHaveLength(0);
  });

  it('emits no terminal events from Executor (gateway /ask owns request.completed/failed)', async () => {
    const port = new StubPort();
    const sink = new CollectingSink();
    const executor = new Executor(
      makeRegistry(),
      undefined,
      undefined,
      makeRunner(port),
      { execContext: { executionId: 'exec-t34-8' }, telemetrySink: sink },
    );
    const skill = subprocessSkill();

    await executor.execute(skill, { query: 'hi' });

    const terminal = sink.events.filter(
      (e) => e.kind === 'request.completed' || e.kind === 'request.failed',
    );
    expect(terminal).toHaveLength(0);
  });

  it('a throwing sink never breaks execute()', async () => {
    const port = new StubPort();
    const executor = new Executor(
      makeRegistry(),
      undefined,
      undefined,
      makeRunner(port),
      { execContext: { executionId: 'exec-t34-9' }, telemetrySink: new ThrowingSink() },
    );
    const skill = subprocessSkill();

    const result = await executor.execute(skill, { query: 'hi' });
    expect('adapterResult' in result && result.adapterResult.success).toBe(true);
  });

  it('generates an executionId when the injected context omits one', async () => {
    const port = new StubPort();
    const sink = new CollectingSink();
    const executor = new Executor(
      makeRegistry(),
      undefined,
      undefined,
      makeRunner(port),
      { telemetrySink: sink }, // no execContext at all
    );
    const skill = subprocessSkill();

    await executor.execute(skill, { query: 'hi' });

    const events = sink.events.filter((e) => e.kind === 'adapter.completed');
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    if (ev.kind !== 'adapter.completed') throw new Error('unreachable');
    expect(typeof ev.executionId).toBe('string');
    expect(ev.executionId.length).toBeGreaterThan(0);
  });
});
