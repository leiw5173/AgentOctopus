/**
 * McpAdapter → sandbox convergence (Plan 5 Task 5).
 *
 * Source guards assert the converged MCP sources contain NO host execution:
 *   - no `StdioClientTransport`
 *   - no `env: process.env`
 *   - no `pkill`
 *   - no direct `child_process` / `spawn`
 *
 * Behavioral tests drive the adapter over a fake, skill-bound
 * `BoundSandboxExecutionPort` whose `spawn()` returns a fake duplex
 * `SandboxProcess` that speaks real newline-delimited JSON-RPC. They assert
 * exactly ONE `spawn()` carries the whole MCP session and the adapter never
 * touches the host.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { LoadedSkill } from '@agentoctopus/registry';
import type {
  AdapterInvocationContext,
  BoundSandboxExecutionPort,
  SandboxCommandRequest,
  SandboxRunOutput,
  SandboxSessionHandle,
} from '../src/adapter.js';
import { McpAdapter } from '../src/mcp-adapter.js';
import { createFrameParser, frameMessage } from '@agentoctopus/sandbox';
import type { BackendRunResult } from '@agentoctopus/sandbox';

// ---------------------------------------------------------------------------
// Fake duplex MCP server over SandboxProcess
// ---------------------------------------------------------------------------

interface FakeMcpProcess {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exited: Promise<BackendRunResult>;
  closeCount: number;
  killCount: number;
  kill(): Promise<void>;
  close(): Promise<void>;
}

/**
 * A fake MCP stdio server. It reads framed JSON-RPC requests from its stdin
 * and writes framed responses to its stdout. Handles the MCP handshake plus
 * tools/list and tools/call.
 */
function makeFakeMcpServer(toolName: string): FakeMcpProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let closeCount = 0;
  let killCount = 0;
  let resolveExited!: (r: BackendRunResult) => void;
  const exited = new Promise<BackendRunResult>((res) => {
    resolveExited = res;
  });

  const respond = (msg: any) => {
    if (msg.method === 'initialize') {
      stdout.write(
        frameMessage({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            serverInfo: { name: 'fake-mcp', version: '0.0.1' },
          },
        }),
      );
    } else if (msg.method === 'tools/list') {
      stdout.write(
        frameMessage({
          jsonrpc: '2.0',
          id: msg.id,
          result: { tools: [{ name: toolName, description: 'fake', inputSchema: { type: 'object' } }] },
        }),
      );
    } else if (msg.method === 'tools/call') {
      stdout.write(
        frameMessage({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: `echo:${JSON.stringify(msg.params?.arguments ?? {})}` }],
          },
        }),
      );
    }
    // Notifications (notifications/initialized) have no id → no response.
  };

  const parse = createFrameParser((m) => respond(m));
  stdin.on('data', (chunk) => parse(chunk as Uint8Array));

  const proc: FakeMcpProcess = {
    stdin,
    stdout,
    stderr,
    exited,
    closeCount: 0,
    killCount: 0,
    kill: async () => {
      killCount++;
    },
    close: async () => {
      closeCount++;
      stdout.end();
      stderr.end();
      resolveExited({
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        meta: { isolationLevel: 'full', backend: 'docker', degraded: false, degradationReasons: [] },
      });
    },
  };
  // expose counters through closure mutation
  Object.defineProperty(proc, 'closeCount', { get: () => closeCount });
  Object.defineProperty(proc, 'killCount', { get: () => killCount });
  return proc;
}

// ---------------------------------------------------------------------------
// Recording BoundSandboxExecutionPort
// ---------------------------------------------------------------------------

class RecordingPort implements BoundSandboxExecutionPort {
  spawnCount = 0;
  spawnCalls: Array<Omit<SandboxCommandRequest, 'invocation'>> = [];
  process: FakeMcpProcess;

  constructor(toolName: string) {
    this.process = makeFakeMcpServer(toolName);
  }

  async run(): Promise<SandboxRunOutput> {
    throw new Error('McpAdapter must use spawn(), not one-shot run()');
  }

  async spawn(
    input: Omit<SandboxCommandRequest, 'invocation'> & { invocation?: { env?: Record<string, string> } },
  ): Promise<SandboxSessionHandle> {
    this.spawnCount++;
    this.spawnCalls.push(input);
    const proc = this.process;
    return {
      process: proc as unknown as SandboxSessionHandle['process'],
      isolationLevel: 'full',
      backend: 'docker',
      close: async () => {
        await proc.close();
      },
    };
  }
}

function makeContext(port: RecordingPort, payload: unknown): AdapterInvocationContext {
  return { sandbox: port, payload, timeoutMs: 5000 };
}

// ---------------------------------------------------------------------------
// Skill fixture
// ---------------------------------------------------------------------------

let skillDir: string | undefined;

function makeSkill(name: string, endpoint: string): LoadedSkill {
  skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oct-mcp-skill-'));
  return {
    dirPath: skillDir,
    manifest: { name, adapter: 'mcp', endpoint, credentials: [] },
  } as unknown as LoadedSkill;
}

describe('McpAdapter (sandbox convergence)', () => {
  afterEach(() => {
    if (skillDir) fs.rmSync(skillDir, { recursive: true, force: true });
    skillDir = undefined;
  });

  it('runs the whole MCP session over exactly ONE sandbox spawn()', async () => {
    const skill = makeSkill('echo-tool', 'fake-mcp-server --flag');
    const port = new RecordingPort('echo-tool');
    const adapter = new McpAdapter();

    const result = await adapter.invoke({ skill, input: { n: 1 } }, makeContext(port, { n: 1 }));

    expect(result.success).toBe(true);
    expect(port.spawnCount).toBe(1);
    // The guest command array is the resolved MCP command split into argv.
    expect(port.spawnCalls[0]!.command).toEqual(['fake-mcp-server', '--flag']);
    // Echo came back through the persistent process.
    expect(result.rawText).toContain('echo:');
    // Transport close → exactly one process close.
    expect(port.process.closeCount).toBe(1);
  });

  it('returns an error when no command or endpoint is provided (no spawn)', async () => {
    const skill = {
      dirPath: fs.mkdtempSync(path.join(os.tmpdir(), 'oct-mcp-empty-')),
      manifest: { name: 'echo-tool', adapter: 'mcp', credentials: [] },
    } as unknown as LoadedSkill;
    skillDir = skill.dirPath;
    const port = new RecordingPort('echo-tool');
    const adapter = new McpAdapter();

    const result = await adapter.invoke({ skill, input: {} }, makeContext(port, {}));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No command or endpoint/);
    expect(port.spawnCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Source guards: NO host execution remains in the converged MCP sources.
  // -------------------------------------------------------------------------

  const readSrc = (rel: string) => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf-8');

  it('source guard: mcp-adapter.ts has no StdioClientTransport / process.env / pkill / child_process', () => {
    const src = readSrc('mcp-adapter.ts');
    expect(src).not.toMatch(/StdioClientTransport/);
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/pkill/);
    expect(src).not.toMatch(/node:child_process|child_process/);
    expect(src).not.toMatch(/\bcp\.spawn|execSync/);
  });

  it('source guard: sandbox-mcp-transport.ts has no host spawn / process.env', () => {
    const src = readSrc('sandbox-mcp-transport.ts');
    expect(src).not.toMatch(/node:child_process|child_process/);
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/StdioClientTransport/);
  });
});
