/**
 * Executor → SandboxRunner convergence (Plan 5 Task 4).
 *
 * Every non-MCP execution path in the Executor must reach the injected
 * SandboxRunner's bound port — never a host subprocess/fetch. These tests
 * inject a recording BoundSandboxExecutionPort via a stub SandboxRunner and
 * drive the real dispatch paths:
 *   - scripts/invoke.js standard subprocess (via SubprocessAdapter)
 *   - LLM-generated subprocess command (bash -c inside the sandbox)
 *   - LLM-generated HTTP/curl command (inside the sandbox via the egress proxy)
 *   - generic adapter.invoke (subprocess adapter receives the bound port)
 *
 * Host side-effect proof: executor.ts has no child_process/bash-spawn/env
 * mutation (source guard in executor-path-matrix.test.ts) and the ONLY
 * execution channel the Executor holds is the injected runner.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import { SandboxRunner } from '../src/sandbox-runner.js';
import {
  makeEventLog,
  RecordingBackend,
  RecordingProxyLauncher,
  RecordingSecretProvider,
  makeTrustedConfig,
  makeSnapshotStore,
  makeSkillFixture,
} from './sandbox-runner.test.js';

vi.mock('../src/utils.js', () => ({
  isBinAvailable: vi.fn().mockReturnValue(true),
}));

// ---------------------------------------------------------------------------
// Recording bound port + stub SandboxRunner
// ---------------------------------------------------------------------------
class RecordingPort implements BoundSandboxExecutionPort {
  runCalls: SandboxCommandRequest[] = [];
  runResult: SandboxRunOutput = {
    success: true,
    rawText: '{"result":"sandbox output"}',
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

function makeRunner(port: RecordingPort): SandboxRunner {
  // Structural stub: the Executor only ever calls runner.bind(skill). Cast to
  // SandboxRunner — this is the DI seam, NOT a host fallback.
  return { bind: () => port } as unknown as SandboxRunner;
}

function makeRegistry(instructions = ''): SkillRegistry {
  return {
    recordInvocation: vi.fn(),
    recordInvocationMetrics: vi.fn(),
    readInstructions: vi.fn().mockReturnValue(instructions),
  } as unknown as SkillRegistry;
}

// ---------------------------------------------------------------------------
// Skill fixtures
// ---------------------------------------------------------------------------
let dirs: string[] = [];

function makeDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oct-exec-skill-'));
  dirs.push(d);
  return d;
}

function subprocessSkillWithInvokeJs(): LoadedSkill {
  const dirPath = makeDir();
  fs.mkdirSync(path.join(dirPath, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dirPath, 'scripts', 'invoke.js'), '// noop');
  return {
    dirPath,
    manifest: { name: 'sub-invoke', adapter: 'subprocess', credentials: [] },
  } as unknown as LoadedSkill;
}

function subprocessSkillNoEntry(): LoadedSkill {
  const dirPath = makeDir();
  // No invoke.js (forces the LLM-guided path), but the LLM-command-referenced
  // script must exist on disk to pass validateCommandScripts.
  fs.mkdirSync(path.join(dirPath, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dirPath, 'scripts', 'run.py'), '# noop');
  return {
    dirPath,
    manifest: { name: 'sub-llm', adapter: 'subprocess', credentials: [] },
  } as unknown as LoadedSkill;
}

function httpSkillNoEndpoint(): LoadedSkill {
  const dirPath = makeDir();
  return {
    dirPath,
    manifest: { name: 'http-llm', adapter: 'http', credentials: [] },
  } as unknown as LoadedSkill;
}

describe('Executor → SandboxRunner convergence', () => {
  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  it('routes scripts/invoke.js subprocess execution through the sandbox port', async () => {
    const port = new RecordingPort();
    const executor = new Executor(makeRegistry(), undefined, undefined, makeRunner(port));
    const skill = subprocessSkillWithInvokeJs();

    const result = await executor.execute(skill, { query: 'hi' });

    expect('formattedOutput' in result && result.formattedOutput).toContain('sandbox output');
    expect(port.runCalls).toHaveLength(1);
    expect(port.runCalls[0]!.command).toEqual(['node', '/skill/scripts/invoke.js']);
    expect(port.runCalls[0]!.invocation?.payload).toEqual({ query: 'hi' });
  });

  it('no-chat subprocess fallback still uses the bound sandbox port', async () => {
    const port = new RecordingPort();
    // No chatClient → executeSubprocessWithLLM not taken; generic adapter.invoke.
    const executor = new Executor(makeRegistry(), undefined, undefined, makeRunner(port));
    const skill = subprocessSkillWithInvokeJs();

    await executor.execute(skill, { query: 'hi' });

    // Exactly one sandbox call, zero host execution.
    expect(port.runCalls).toHaveLength(1);
    expect(port.runCalls[0]!.command[1]).toBe('/skill/scripts/invoke.js');
  });

  it('LLM-generated subprocess command runs via bash -c INSIDE the sandbox', async () => {
    const port = new RecordingPort();
    port.runResult = {
      success: true,
      rawText: 'llm-cmd-output',
      isolationLevel: 'full',
      backend: 'docker',
      meta: { isolationLevel: 'full', backend: 'docker', degraded: false, degradationReasons: [] },
    };
    const chatClient = { chat: vi.fn().mockResolvedValue('python3 scripts/run.py --fast') } as any;
    const executor = new Executor(makeRegistry('run python3 scripts/run.py'), chatClient, undefined, makeRunner(port));
    const skill = subprocessSkillNoEntry();

    const result = await executor.execute(skill, { query: 'go' });

    expect('formattedOutput' in result && result.formattedOutput).toContain('llm-cmd-output');
    expect(port.runCalls).toHaveLength(1);
    const call = port.runCalls[0]!;
    expect(call.command[0]).toBe('bash');
    expect(call.command[1]).toBe('-c');
    expect(call.command[2]).toContain('python3 scripts/run.py');
    expect(call.invocation?.payload).toEqual({ query: 'go' });
  });

  it('LLM-generated HTTP/curl command runs INSIDE the sandbox (egress via proxy)', async () => {
    const port = new RecordingPort();
    port.runResult = {
      success: true,
      rawText: '{"temp":72}',
      isolationLevel: 'full',
      backend: 'docker',
      meta: { isolationLevel: 'full', backend: 'docker', degraded: false, degradationReasons: [] },
    };
    const chatClient = { chat: vi.fn().mockResolvedValue("curl -s https://api.example.com/weather?q=tokyo") } as any;
    const instructions = 'GET https://api.example.com/weather?q=<city>';
    const executor = new Executor(makeRegistry(instructions), chatClient, undefined, makeRunner(port));
    const skill = httpSkillNoEndpoint();

    const result = await executor.execute(skill, { query: 'tokyo weather' });

    expect(port.runCalls).toHaveLength(1);
    const call = port.runCalls[0]!;
    expect(call.command[0]).toBe('bash');
    expect(call.command[1]).toBe('-c');
    expect(call.command[2]).toContain('curl');
    expect(call.invocation?.payload).toEqual({ query: 'tokyo weather' });
  });

  it('propagates a fail-closed sandbox error as an AdapterResult error', async () => {
    const port = new RecordingPort();
    port.runResult = {
      success: false,
      error: 'NO_SATISFYING_BACKEND: no sandbox backend meets isolationLevel >= full (fail-closed)',
      isolationLevel: 'none',
      backend: 'none',
      meta: { isolationLevel: 'none', backend: 'none', degraded: false, degradationReasons: [] },
    };
    const executor = new Executor(makeRegistry(), undefined, undefined, makeRunner(port));
    const skill = subprocessSkillWithInvokeJs();

    const result = await executor.execute(skill, { query: 'hi' });

    expect('formattedOutput' in result && result.formattedOutput).toMatch(/NO_SATISFYING_BACKEND/);
  });

  it('constructs a real default SandboxRunner when none is injected (never a host fallback)', () => {
    // The 3-arg constructor (production call sites) must still hold a real runner.
    const executor = new Executor(makeRegistry());
    const runner = (executor as any).sandboxRunner as SandboxRunner;
    expect(runner).toBeInstanceOf(SandboxRunner);
    expect(typeof runner.bind).toBe('function');
  });
});

/**
 * REAL-RUNNER regression tests (review C1): drive the actual
 * `SandboxRunner.run` → `rewriteCommand` with a RecordingBackend, and assert
 * the `-c` payload is NOT mangled into `/skill/<shell string>`. These tests do
 * NOT inject a stub port — they exercise the real path-rewriting code, closing
 * the test-blindness hole where pre-rewrite assertions masked the corruption.
 */
describe('Executor → REAL SandboxRunner.run (rewriteCommand -c opaque)', () => {
  let storeDir: string;

  function realRunner(backend: RecordingBackend, record: (n: string, d?: unknown) => void): SandboxRunner {
    // Snapshot store dirs are left in os.tmpdir() (same convention as the
    // existing sandbox-runner tests) — content-addressed temp artifacts are
    // harmless and rmSync hits a macOS ENOTEMPTY race if we delete eagerly.
    storeDir = makeSnapshotStore();
    return new SandboxRunner({
      config: makeTrustedConfig(),
      snapshotStoreDir: storeDir,
      backends: [backend],
      proxyLauncher: new RecordingProxyLauncher(record),
      secretProvider: new RecordingSecretProvider(),
      installationIdFor: () => 'inst-1',
      onEvent: record,
    });
  }

  afterEach(() => {
    for (const d of dirs) {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    dirs = [];
  });

  it('LLM-guided subprocess: bash -c payload reaches the backend verbatim', async () => {
    const { record } = makeEventLog();
    const backend = new RecordingBackend('docker', 'full', record);
    backend.runResult = {
      exitCode: 0,
      stdout: 'llm-subprocess-ok',
      stderr: '',
      timedOut: false,
      meta: { isolationLevel: 'full', backend: 'docker', degraded: false, degradationReasons: [] },
    };
    const runner = realRunner(backend, record);

    // Skill fixture with scripts/run.py present (passes validateCommandScripts)
    // but NO invoke.js (forces the LLM-guided bash -c path).
    const { dir, skill } = makeSkillFixture({ instructions: 'run python3 scripts/run.py' });
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts', 'run.py'), '# noop');

    const chatClient = { chat: vi.fn().mockResolvedValue('python3 scripts/run.py --fast') } as any;
    const executor = new Executor(makeRegistry('run python3 scripts/run.py'), chatClient, undefined, runner);

    const result = await executor.execute(skill, { query: 'go' });
    expect('formattedOutput' in result && result.formattedOutput).toContain('llm-subprocess-ok');

    // The REAL rewriteCommand ran: backend captured the post-rewrite ExecSpec.
    const cmd = backend.lastRunSpec!.command;
    expect(cmd[0]).toBe('bash');
    expect(cmd[1]).toBe('-c');
    // The opaque shell payload is intact — NOT rewritten to /skill/...
    expect(cmd[2]).toBe('python3 scripts/run.py --fast');
    expect(cmd.join(' ')).not.toContain('/skill/python3');
  });

  it('LLM-guided curl: bash -c payload with a URL reaches the backend verbatim', async () => {
    const { record } = makeEventLog();
    const backend = new RecordingBackend('docker', 'full', record);
    backend.runResult = {
      exitCode: 0,
      stdout: '{"temp":72}',
      stderr: '',
      timedOut: false,
      meta: { isolationLevel: 'full', backend: 'docker', degraded: false, degradationReasons: [] },
    };
    const runner = realRunner(backend, record);

    const { dir, skill } = makeSkillFixture({
      name: 'http-llm',
      instructions: 'GET https://api.example.com/weather?q=<city>',
    });
    dirs.push(dir);
    (skill.manifest as any).adapter = 'http';

    const chatClient = { chat: vi.fn().mockResolvedValue('curl -s https://api.example.com/weather?q=tokyo') } as any;
    const executor = new Executor(
      makeRegistry('GET https://api.example.com/weather?q=<city>'),
      chatClient,
      undefined,
      runner,
    );

    const result = await executor.execute(skill, { query: 'tokyo weather' });
    expect('formattedOutput' in result && result.formattedOutput).toContain('temp');

    const cmd = backend.lastRunSpec!.command;
    expect(cmd[0]).toBe('bash');
    expect(cmd[1]).toBe('-c');
    // URL payload intact — NOT rewritten to /skill/https://...
    expect(cmd[2]).toBe('curl -s https://api.example.com/weather?q=tokyo');
    expect(cmd.join(' ')).not.toContain('/skill/https');
  });

  it('non -c tokens keep their path-escape rejection (no regression)', async () => {
    const { record } = makeEventLog();
    const backend = new RecordingBackend('docker', 'full', record);
    const runner = realRunner(backend, record);
    const { dir, skill } = makeSkillFixture();
    dirs.push(dir);

    // Absolute path outside /skill must still be rejected by rewriteCommand.
    const denied = await runner.run({ skill, command: ['node', '/etc/passwd'] });
    expect(denied.success).toBe(false);
    expect(denied.error).toMatch(/COMMAND_PATH_REJECTED/);

    // `..` traversal must still be rejected.
    const traversal = await runner.run({ skill, command: ['node', '../escape.js'] });
    expect(traversal.success).toBe(false);
    expect(traversal.error).toMatch(/COMMAND_PATH_REJECTED/);
  });
});
