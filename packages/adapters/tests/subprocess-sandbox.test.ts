/**
 * SubprocessAdapter → sandbox convergence (Plan 5 Task 4, matrix row:
 * "scripts/invoke.js normal skill execution" + "SubprocessAdapter delegates to
 * context.sandbox.run").
 *
 * Behavioral: the adapter delegates to the injected, skill-bound
 * `context.sandbox.run` with the guest path `/skill/scripts/<entry>` and the
 * serialized payload, and NEVER spawns on the host.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LoadedSkill } from '@agentoctopus/registry';
import type {
  AdapterInvocationContext,
  BoundSandboxExecutionPort,
  SandboxCommandRequest,
  SandboxRunOutput,
} from '../src/adapter.js';
import { SubprocessAdapter } from '../src/subprocess-adapter.js';

// ---------------------------------------------------------------------------
// Recording BoundSandboxExecutionPort
// ---------------------------------------------------------------------------
class RecordingPort implements BoundSandboxExecutionPort {
  runCalls: SandboxCommandRequest[] = [];
  runResult: SandboxRunOutput = {
    success: true,
    rawText: '{"ok":true}',
    isolationLevel: 'full',
    backend: 'docker',
  };

  async run(input: SandboxCommandRequest): Promise<SandboxRunOutput> {
    this.runCalls.push(input);
    return this.runResult;
  }

  async spawn(): Promise<never> {
    throw new Error('spawn not used by SubprocessAdapter');
  }
}

function makeContext(port: RecordingPort, payload: unknown): AdapterInvocationContext {
  return { sandbox: port, payload, timeoutMs: 5000 };
}

// ---------------------------------------------------------------------------
// Skill fixture
// ---------------------------------------------------------------------------
let skillDir: string;

function makeSkill(): LoadedSkill {
  skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oct-subprocess-skill-'));
  fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'scripts', 'invoke.js'), '// noop');
  return {
    dirPath: skillDir,
    manifest: { name: 'test-subprocess', adapter: 'subprocess', credentials: [] },
  } as unknown as LoadedSkill;
}

describe('SubprocessAdapter (sandbox convergence)', () => {
  afterEach(() => {
    if (skillDir) fs.rmSync(skillDir, { recursive: true, force: true });
  });

  it('delegates to context.sandbox.run with the guest script path and payload', async () => {
    const skill = makeSkill();
    const port = new RecordingPort();
    const adapter = new SubprocessAdapter();

    const result = await adapter.invoke(
      { skill, input: { query: 'hello' } },
      makeContext(port, { query: 'hello' }),
    );

    expect(result.success).toBe(true);
    expect(port.runCalls).toHaveLength(1);
    const call = port.runCalls[0]!;
    // Guest path: snapshot mounted at /skill; runtime resolves via guest PATH.
    expect(call.command).toEqual(['node', '/skill/scripts/invoke.js']);
    // Payload serialized for OCTOPUS_INPUT + stdin by the runner.
    expect(call.invocation?.payload).toEqual({ query: 'hello' });
    expect(call.invocation?.stdin).toBe(JSON.stringify({ query: 'hello' }));
    expect(call.timeoutMs).toBe(5000);
    // No host spawn: the adapter has no child_process import (source guard
    // below) and the recording port is the ONLY execution channel it receives.
  });

  it('parses JSON stdout into data', async () => {
    const skill = makeSkill();
    const port = new RecordingPort();
    port.runResult = { success: true, rawText: '{"a":1}', isolationLevel: 'full', backend: 'docker' };
    const adapter = new SubprocessAdapter();

    const result = await adapter.invoke({ skill, input: {} }, makeContext(port, {}));
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ a: 1 });
  });

  it('propagates sandbox failure as a typed AdapterResult error', async () => {
    const skill = makeSkill();
    const port = new RecordingPort();
    port.runResult = {
      success: false,
      error: 'NO_SATISFYING_BACKEND: no sandbox backend meets isolationLevel >= full',
      isolationLevel: 'none',
      backend: 'none',
    };
    const adapter = new SubprocessAdapter();

    const result = await adapter.invoke({ skill, input: {} }, makeContext(port, {}));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/NO_SATISFYING_BACKEND/);
  });

  it('returns an error when no entry script exists (no sandbox call)', async () => {
    skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oct-empty-skill-'));
    const skill = {
      dirPath: skillDir,
      manifest: { name: 'empty', adapter: 'subprocess', credentials: [] },
    } as unknown as LoadedSkill;
    const port = new RecordingPort();
    const adapter = new SubprocessAdapter();

    const result = await adapter.invoke({ skill, input: {} }, makeContext(port, {}));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No script found/);
    expect(port.runCalls).toHaveLength(0);
  });

  it('source guard: adapter source has no child_process import', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'subprocess-adapter.ts'),
      'utf-8',
    );
    expect(src).not.toMatch(/node:child_process|child_process/);
  });
});
