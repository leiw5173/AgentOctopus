/**
 * SandboxMcpTransport session persistence (Plan 5 Task 5; Plan 6 contract).
 *
 * Drives the transport with a REAL MCP `Client` over a fake skill-bound
 * `BoundSandboxExecutionPort` whose single `spawn()` returns a fake duplex
 * `SandboxProcess`. Asserts:
 *
 *   - exactly ONE port.spawn() and ONE child PID across initialize,
 *     notifications/initialized, tools/list, and MULTIPLE tools/call requests;
 *   - multiple outstanding messages on one persistent process;
 *   - stderr stays a diagnostics-only channel (never mixed into JSON-RPC);
 *   - close() closes the process exactly once.
 */
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type {
  BoundSandboxExecutionPort,
  SandboxCommandRequest,
  SandboxRunOutput,
  SandboxSessionHandle,
} from '../src/adapter.js';
import { SandboxMcpTransport } from '../src/sandbox-mcp-transport.js';
import { createFrameParser, frameMessage } from '@agentoctopus/sandbox';
import type { BackendRunResult } from '@agentoctopus/sandbox';

function makeFakeMcpServer(toolName: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let closeCount = 0;
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
          result: { content: [{ type: 'text', text: `echo:${msg.params?.arguments?.n}` }] },
        }),
      );
    }
  };

  const parse = createFrameParser((m) => respond(m));
  stdin.on('data', (chunk) => parse(chunk as Uint8Array));

  const exitResult: BackendRunResult = {
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    meta: { isolationLevel: 'full', backend: 'docker', degraded: false, degradationReasons: [] },
  };
  const proc = {
    stdin,
    stdout,
    stderr,
    exited,
    kill: async () => {},
    close: async () => {
      closeCount++;
      stdout.end();
      stderr.end();
      resolveExited(exitResult);
    },
  };
  return {
    proc,
    getCloseCount: () => closeCount,
    peerExit: () => resolveExited(exitResult),
  };
}

class SessionPort implements BoundSandboxExecutionPort {
  spawnCount = 0;
  pids: number[] = [];
  private server = makeFakeMcpServer('echo');

  async run(): Promise<SandboxRunOutput> {
    throw new Error('not used');
  }

  async spawn(
    _input: Omit<SandboxCommandRequest, 'invocation'>,
  ): Promise<SandboxSessionHandle> {
    this.spawnCount++;
    this.pids.push(this.spawnCount); // one logical PID per spawn
    const proc = this.server.proc;
    return {
      process: proc as unknown as SandboxSessionHandle['process'],
      isolationLevel: 'full',
      backend: 'docker',
      close: async () => {
        await proc.close();
      },
    };
  }

  get closeCount() {
    return this.server.getCloseCount();
  }

  get stderrBuf() {
    return this.server.proc.stderr;
  }

  peerExit() {
    this.server.peerExit();
  }
}

describe('SandboxMcpTransport session', () => {
  it('keeps one child alive across initialize, tools/list, and multiple tools/call', async () => {
    const port = new SessionPort();
    const transport = new SandboxMcpTransport({
      port,
      command: ['fake-mcp-server'],
      timeoutMs: 5000,
    });

    const client = new Client({ name: 'test-client', version: '0.0.1' }, { capabilities: {} });

    await transport.start();
    await client.connect(transport);

    // Emit a stderr diagnostics line mid-session; it must not corrupt JSON-RPC.
    port.stderrBuf.write('mcp-server: warm cache\n');

    const tools = await client.listTools();
    expect(tools).toEqual(expect.objectContaining({ tools: expect.any(Array) }));

    const r1 = await client.callTool({ name: 'echo', arguments: { n: 1 } });
    expect(r1).toMatchObject({ content: expect.any(Array) });

    const r2 = await client.callTool({ name: 'echo', arguments: { n: 2 } });
    expect(r2).toMatchObject({ content: expect.any(Array) });

    // One spawn, one PID, across the whole session.
    expect(port.spawnCount).toBe(1);
    expect(port.pids).toHaveLength(1);

    await client.close();
    await transport.close();
    expect(port.closeCount).toBe(1);
  });

  it('close() is idempotent — closes the process exactly once', async () => {
    const port = new SessionPort();
    const transport = new SandboxMcpTransport({ port, command: ['x'], timeoutMs: 5000 });
    await transport.start();
    await transport.close();
    await transport.close();
    expect(port.closeCount).toBe(1);
  });

  it('peer exit closes the runner-owned session exactly once before onclose', async () => {
    const port = new SessionPort();
    const transport = new SandboxMcpTransport({ port, command: ['x'], timeoutMs: 5000 });
    let observedCloseCount = -1;
    transport.onclose = () => {
      observedCloseCount = port.closeCount;
    };

    await transport.start();
    port.peerExit();
    await new Promise((r) => setImmediate(r));

    expect(port.closeCount).toBe(1);
    expect(observedCloseCount).toBe(1);
    await transport.close();
    expect(port.closeCount).toBe(1);
  });

  it('surfaces malformed frames via onerror without closing the session', async () => {
    const port = new SessionPort();
    const transport = new SandboxMcpTransport({ port, command: ['x'], timeoutMs: 5000 });
    const errors: Error[] = [];
    transport.onerror = (e) => errors.push(e);
    await transport.start();

    // Push garbage onto stdout directly (bypassing the fake server's framing).
    (transport as any).session?.process.stdout.write('{not json}\n');

    await new Promise((r) => setImmediate(r));
    expect(errors.length).toBeGreaterThan(0);

    await transport.close();
    expect(port.closeCount).toBe(1);
  });
});
