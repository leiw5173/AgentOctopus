/**
 * Execution/network path-matrix — source guards + generic-invoke injection
 * (Plan 5 Task 4, Step 1 + the "generic adapter.invoke" matrix row).
 *
 * Source guards read the actual converged source files and reject host
 * execution/network patterns. Source tests SUPPLEMENT the behavioral tests in
 * executor-sandbox.test.ts; they do not replace them.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LoadedSkill, SkillRegistry } from '@agentoctopus/registry';
import type {
  Adapter,
  AdapterInput,
  AdapterInvocationContext,
  AdapterResult,
  BoundSandboxExecutionPort,
  SandboxRunOutput,
} from '@agentoctopus/adapters';
import { Executor } from '../src/executor.js';
import { SandboxRunner } from '../src/sandbox-runner.js';

vi.mock('../src/utils.js', () => ({
  isBinAvailable: vi.fn().mockReturnValue(true),
}));

const CORE_SRC = path.join(__dirname, '..', 'src');
const ADAPTERS_SRC = path.join(__dirname, '..', '..', 'adapters', 'src');

function readSrc(dir: string, file: string): string {
  return fs.readFileSync(path.join(dir, file), 'utf-8');
}

describe('path-matrix source guards', () => {
  it('executor source has no host spawn / bash-spawn / env-override mutation', () => {
    const executorSource = readSrc(CORE_SRC, 'executor.ts');
    expect(executorSource).not.toMatch(/cp\.spawn|spawn\(['"]bash|applySkillEnvOverrides/);
  });

  it('subprocess adapter source has no child_process import', () => {
    const subprocessSource = readSrc(ADAPTERS_SRC, 'subprocess-adapter.ts');
    expect(subprocessSource).not.toMatch(/node:child_process|child_process/);
  });

  it('http adapter source performs no host fetch/axios/http.request', () => {
    const httpSource = readSrc(ADAPTERS_SRC, 'http-adapter.ts');
    expect(httpSource).not.toMatch(/\bfetch\s*\(|axios\.|http\.request|https\.request/);
  });

  it('no converged source matches env: process.env | pkill | OpenShell spawn', () => {
    const allSources = [
      readSrc(CORE_SRC, 'executor.ts'),
      readSrc(ADAPTERS_SRC, 'subprocess-adapter.ts'),
      readSrc(ADAPTERS_SRC, 'http-adapter.ts'),
      readSrc(ADAPTERS_SRC, 'adapter.ts'),
    ].join('\n');
    expect(allSources).not.toMatch(/env:\s*process\.env|pkill|OpenShell.*spawn/si);
  });

  it('legacy adapter files are absent from the adapters package', () => {
    for (const f of ['docker-adapter.ts', 'ssh-adapter.ts', 'openshell-adapter.ts']) {
      expect(fs.existsSync(path.join(ADAPTERS_SRC, 'sandbox', f)), f).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// generic adapter.invoke: required AdapterInvocationContext.sandbox
// ---------------------------------------------------------------------------

class RecordingPort implements BoundSandboxExecutionPort {
  runCalls: number = 0;
  runResult: SandboxRunOutput = {
    success: true,
    rawText: 'generic-output',
    isolationLevel: 'full',
    backend: 'docker',
  };
  async run(): Promise<SandboxRunOutput> {
    this.runCalls++;
    return this.runResult;
  }
  async spawn(): Promise<never> {
    throw new Error('not used');
  }
}

/** A fake adapter that ASSERTS the injected sandbox context is present. */
class ContextAssertingAdapter implements Adapter {
  seenContexts: AdapterInvocationContext[] = [];
  async invoke(_input: AdapterInput, context: AdapterInvocationContext): Promise<AdapterResult> {
    this.seenContexts.push(context);
    if (!context || !context.sandbox || typeof context.sandbox.run !== 'function') {
      return { success: false, error: 'AdapterInvocationContext.sandbox missing' };
    }
    const out = await context.sandbox.run({ command: ['node', '/skill/scripts/invoke.js'] });
    return { success: out.success, rawText: out.rawText };
  }
}

function makeRegistry(instructions = ''): SkillRegistry {
  return {
    recordInvocation: vi.fn(),
    recordInvocationMetrics: vi.fn(),
    readInstructions: vi.fn().mockReturnValue(instructions),
  } as unknown as SkillRegistry;
}

let dirs: string[] = [];
function makeHttpSkillWithEndpoint(): LoadedSkill {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'oct-generic-skill-'));
  dirs.push(dirPath);
  return {
    dirPath,
    manifest: { name: 'generic-http', adapter: 'http', endpoint: 'https://api.example.com/x', credentials: [] },
  } as unknown as LoadedSkill;
}

describe('generic adapter.invoke injects the bound sandbox context', () => {
  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  it('every invoke receives a context whose sandbox is the injected runner port', async () => {
    const port = new RecordingPort();
    const runner = { bind: () => port } as unknown as SandboxRunner;
    const executor = new Executor(makeRegistry(), undefined, undefined, runner);

    // Swap in the context-asserting adapter as the http adapter.
    const fake = new ContextAssertingAdapter();
    (executor as any).http = fake;

    const skill = makeHttpSkillWithEndpoint();
    const result = await executor.execute(skill, { query: 'q' });

    expect('formattedOutput' in result && result.formattedOutput).toContain('generic-output');
    expect(fake.seenContexts.length).toBeGreaterThan(0);
    for (const ctx of fake.seenContexts) {
      expect(ctx.sandbox).toBe(port);
      expect(typeof ctx.timeoutMs).toBe('number');
    }
    // The adapter executed through the bound port (one sandbox call).
    expect(port.runCalls).toBe(1);
  });

  it('repeated invocations each receive the bound sandbox (retry/fallback re-entry)', async () => {
    const port = new RecordingPort();
    const runner = { bind: () => port } as unknown as SandboxRunner;
    const executor = new Executor(makeRegistry(), undefined, undefined, runner);
    const fake = new ContextAssertingAdapter();
    (executor as any).http = fake;

    // Simulate the caller retrying the same skill across fallback candidates:
    // each execute() re-binds and re-injects the sandbox context.
    for (let i = 0; i < 3; i++) {
      const skill = makeHttpSkillWithEndpoint();
      await executor.execute(skill, { query: `q${i}` });
    }

    expect(fake.seenContexts).toHaveLength(3);
    expect(port.runCalls).toBe(3); // three candidates → three runner calls
    for (const ctx of fake.seenContexts) {
      expect(ctx.sandbox).toBe(port);
    }
  });
});
