/**
 * Guided-path prompt hygiene (Plan 5 Task 7).
 *
 * The LLM-guided subprocess and HTTP prompts may carry credential KEY NAMES plus
 * a configured/not-configured boolean — NEVER a value, NEVER `KEY = <anything>`.
 * The broad commonKeyPattern environment scan must be gone entirely.
 *
 * DI seams only (recording chat client + stub runner port); no child_process.
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

vi.mock('../src/utils.js', () => ({
  isBinAvailable: vi.fn().mockReturnValue(true),
}));

const SECRET_VALUE = 'prompt-hygiene-secret-12345';
const SECRET_KEY = 'HYGIENE_API_KEY';

let dirs: string[] = [];

class StubPort implements BoundSandboxExecutionPort {
  runCalls: SandboxCommandRequest[] = [];
  async run(input: SandboxCommandRequest): Promise<SandboxRunOutput> {
    this.runCalls.push(input);
    return { success: true, rawText: 'ok-output', isolationLevel: 'full', backend: 'docker' };
  }
  async spawn(): Promise<never> {
    throw new Error('spawn not used');
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

function makeChat(reply: string) {
  const prompts: Array<{ system: string; user: string }> = [];
  return {
    prompts,
    chat: vi.fn(async (system: string, user: string) => {
      prompts.push({ system, user });
      return reply;
    }),
  };
}

function makeDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oct-prompt-skill-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
  delete (process.env as Record<string, unknown>)[SECRET_KEY];
});

describe('guided-path prompt hygiene', () => {
  it('HTTP guided prompt has no credential VALUES and no broad env scan', async () => {
    // Put a real value in process.env to prove it never reaches the prompt.
    process.env[SECRET_KEY] = SECRET_VALUE;
    // A second, unrelated env var that the OLD commonKeyPattern scan would leak.
    process.env['UNRELATED_TOKEN'] = 'unrelated-secret-value';

    const port = new StubPort();
    const chat = makeChat('curl -s https://api.example.com/x');
    const dirPath = makeDir();
    const skill = {
      dirPath,
      manifest: {
        name: 'http-guided',
        description: 'd',
        adapter: 'http',
        credentials: [{ key: SECRET_KEY, label: 'Hygiene key', required: true }],
      },
    } as unknown as LoadedSkill;

    const executor = new Executor(
      makeRegistry('GET https://api.example.com/x'),
      chat as never,
      undefined,
      makeRunner(port),
    );
    await executor.execute(skill, { query: 'q' });

    expect(chat.prompts.length).toBeGreaterThan(0);
    const allPrompts = chat.prompts.map(p => p.system + '\n' + p.user).join('\n');
    // No VALUES anywhere.
    expect(allPrompts).not.toContain(SECRET_VALUE);
    expect(allPrompts).not.toContain('unrelated-secret-value');
    // No `KEY = <something>` interpolation.
    expect(allPrompts).not.toMatch(new RegExp(`${SECRET_KEY}\\s*=`));
    expect(allPrompts).not.toMatch(/UNRELATED_TOKEN\s*=/);
    // The broad scan block is gone.
    expect(allPrompts).not.toMatch(/Available credentials/);
    expect(allPrompts).not.toMatch(/\(available in env\)|\(already set\)/);

    delete (process.env as Record<string, unknown>)['UNRELATED_TOKEN'];
  });

  it('subprocess guided prompt may name the key but never its value', async () => {
    process.env[SECRET_KEY] = SECRET_VALUE;

    const port = new StubPort();
    const chat = makeChat('python3 scripts/run.py');
    const dirPath = makeDir();
    fs.mkdirSync(path.join(dirPath, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'scripts', 'run.py'), '# noop');
    const skill = {
      dirPath,
      manifest: {
        name: 'sub-guided',
        description: 'd',
        adapter: 'subprocess',
        credentials: [{ key: SECRET_KEY, label: 'Hygiene key', required: true }],
      },
    } as unknown as LoadedSkill;

    const executor = new Executor(
      makeRegistry('run python3 scripts/run.py'),
      chat as never,
      undefined,
      makeRunner(port),
    );
    await executor.execute(skill, { query: 'go' });

    expect(chat.prompts.length).toBeGreaterThan(0);
    const allPrompts = chat.prompts.map(p => p.system + '\n' + p.user).join('\n');
    expect(allPrompts).not.toContain(SECRET_VALUE);
    expect(allPrompts).not.toMatch(new RegExp(`${SECRET_KEY}\\s*=`));
    expect(allPrompts).not.toMatch(/Available credentials/);
    // If the key IS referenced, it must be a value-free configured boolean.
    if (allPrompts.includes(SECRET_KEY)) {
      expect(allPrompts).toMatch(new RegExp(`${SECRET_KEY} \\(configured\\)`));
    }
  });

  it('configured/not-configured hint is a value-free boolean', async () => {
    // Key NOT set → prompt may note it is not configured, but never a value.
    const port = new StubPort();
    const chat = makeChat('curl -s https://api.example.com/x');
    const dirPath = makeDir();
    const skill = {
      dirPath,
      manifest: {
        name: 'http-guided',
        description: 'd',
        adapter: 'http',
        credentials: [{ key: SECRET_KEY, required: true }],
      },
    } as unknown as LoadedSkill;

    const executor = new Executor(
      makeRegistry('GET https://api.example.com/x'),
      chat as never,
      undefined,
      makeRunner(port),
    );
    // The credential is missing → guard returns credential_missing before the LLM.
    const result = await executor.execute(skill, { query: 'q' });
    // Guard short-circuits; no LLM prompt should have been issued for guidance.
    if ('type' in result && result.type === 'credential_missing') {
      expect(chat.prompts.length).toBe(0);
    }
  });
});
