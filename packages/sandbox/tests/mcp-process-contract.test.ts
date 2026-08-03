/**
 * MCP stdio framing primitives + persistent process lifecycle contract
 * (Plan 5 Task 5; Plan 6 contract target).
 *
 * Two halves:
 *
 *   1. Framing round-trip — `frameMessage` emits one JSON object plus a
 *      trailing `\n`; `createFrameParser` reassembles frames split across
 *      chunks, emits multiple messages from one chunk, skips empty lines, and
 *      throws `MalformedFrameError` on invalid JSON and on non-object JSON.
 *
 *   2. Process lifecycle — a fake duplex `SandboxProcess` drives exactly ONE
 *      `spawn()` for FOUR request frames written through `frameMessage`;
 *      FOUR responses are collected via `createFrameParser` from
 *      `SandboxProcess.stdout`; stderr stays separate; `exited` resolves with
 *      the canonical four-field `SandboxResultMeta` after `close()`.
 *
 * No real child_process, no Docker daemon, no kernel — a behavioral fake only.
 */
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  frameMessage,
  createFrameParser,
  MalformedFrameError,
} from '../src/mcp-stdio-relay.js';
import type { SandboxProcess, BackendRunResult } from '../src/backend.js';

// ---------------------------------------------------------------------------
// Framing round-trip
// ---------------------------------------------------------------------------

describe('MCP stdio framing', () => {
  it('frameMessage emits one JSON object plus a trailing newline', () => {
    const framed = frameMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const text = new TextDecoder().decode(framed);
    expect(text).toBe('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
  });

  it('reassembles a frame split across two chunks', () => {
    const seen: unknown[] = [];
    const parse = createFrameParser((m) => seen.push(m));
    parse('{"jsonrpc":"2.0","id":');
    expect(seen).toHaveLength(0);
    parse('1,"result":{}}\n');
    expect(seen).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
  });

  it('emits two messages from one chunk', () => {
    const seen: unknown[] = [];
    const parse = createFrameParser((m) => seen.push(m));
    parse('{"id":1,"result":{}}\n{"id":2,"result":{}}\n');
    expect(seen).toEqual([{ id: 1, result: {} }, { id: 2, result: {} }]);
  });

  it('skips empty lines', () => {
    const seen: unknown[] = [];
    const parse = createFrameParser((m) => seen.push(m));
    parse('\n   \n{"id":1}\n\n');
    expect(seen).toEqual([{ id: 1 }]);
  });

  it('throws MalformedFrameError on invalid JSON', () => {
    const parse = createFrameParser(() => {});
    expect(() => parse('{not json}\n')).toThrow(MalformedFrameError);
  });

  it('throws MalformedFrameError on non-object JSON', () => {
    const parse = createFrameParser(() => {});
    expect(() => parse('"just a string"\n')).toThrow(MalformedFrameError);
    expect(() => parse('42\n')).toThrow(MalformedFrameError);
    expect(() => parse('null\n')).toThrow(MalformedFrameError);
  });
});

// ---------------------------------------------------------------------------
// Persistent process lifecycle over a fake duplex SandboxProcess
// ---------------------------------------------------------------------------

function makeRunResult(stdout: string, stderr: string): BackendRunResult {
  return {
    exitCode: 0,
    stdout,
    stderr,
    timedOut: false,
    meta: {
      isolationLevel: 'full',
      backend: 'docker',
      degraded: false,
      degradationReasons: [],
    },
  };
}

interface FakeDuplexProcess extends SandboxProcess {
  stdinBuf: PassThrough;
  stdoutBuf: PassThrough;
  stderrBuf: PassThrough;
  closeCount: number;
  resolveExited: (r: BackendRunResult) => void;
}

function makeFakeDuplexProcess(): FakeDuplexProcess {
  const stdinBuf = new PassThrough();
  const stdoutBuf = new PassThrough();
  const stderrBuf = new PassThrough();
  let closeCount = 0;
  let resolveExited!: (r: BackendRunResult) => void;
  const exited = new Promise<BackendRunResult>((res) => {
    resolveExited = res;
  });
  const proc: FakeDuplexProcess = {
    stdinBuf,
    stdoutBuf,
    stderrBuf,
    closeCount: 0,
    resolveExited,
    stdin: stdinBuf,
    stdout: stdoutBuf,
    stderr: stderrBuf,
    exited,
    kill: async () => {},
    close: async () => {
      proc.closeCount = ++closeCount;
      stdoutBuf.end();
      stderrBuf.end();
    },
  };
  return proc;
}

describe('MCP persistent process lifecycle (fake duplex)', () => {
  it('one spawn carries four request frames and four parsed responses; stderr separate; exited resolves after close', async () => {
    let spawnCount = 0;
    const proc = makeFakeDuplexProcess();

    // The "backend" — exactly one spawn.
    const spawn = async (): Promise<SandboxProcess> => {
      spawnCount++;
      return proc;
    };

    const process = await spawn();

    // Client side: frame four requests onto stdin.
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { n: 1 } } },
    ];
    for (const req of requests) {
      process.stdin.write(frameMessage(req));
    }

    // Assert all four frames landed on stdin, newline-delimited.
    const stdinText = await new Promise<string>((resolve) => {
      let acc = '';
      proc.stdinBuf.on('data', (c) => {
        acc += c.toString();
        if (acc.split('\n').filter((l) => l.trim().length > 0).length >= 4) resolve(acc);
      });
    });
    expect(stdinText.trim().split('\n')).toHaveLength(4);

    // Server side: emit four responses on stdout, plus a diagnostics line on
    // stderr that must never reach the JSON-RPC parser.
    proc.stderrBuf.write('mcp-server: listening on stdio\n');
    const responses = [
      { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } },
      { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'echo' }] } },
      { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'echo:1' }] } },
      { jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: 'echo:2' }] } },
    ];
    // Write first two as one coalesced chunk, third split across chunks, then fourth.
    proc.stdoutBuf.write(frameMessage(responses[0]));
    proc.stdoutBuf.write(frameMessage(responses[1]));
    const third = new TextDecoder().decode(frameMessage(responses[2]));
    proc.stdoutBuf.write(third.slice(0, 10));
    proc.stdoutBuf.write(third.slice(10));
    proc.stdoutBuf.write(frameMessage(responses[3]));

    const received: unknown[] = [];
    const parse = createFrameParser((m) => received.push(m));
    const done = new Promise<void>((resolve) => {
      proc.stdoutBuf.on('data', (chunk) => {
        parse(chunk as Uint8Array);
        if (received.length >= 4) resolve();
      });
    });
    await done;

    // Exactly one spawn carried the whole session.
    expect(spawnCount).toBe(1);
    // All four responses parsed, in order.
    expect(received).toEqual(responses);
    // None of the responses contain stderr text.
    expect(JSON.stringify(received)).not.toMatch(/listening on stdio/);

    // Close the process; `exited` resolves with the canonical four-field meta.
    let stderrText = '';
    proc.stderrBuf.on('data', (c) => {
      stderrText += c.toString();
    });
    proc.resolveExited(makeRunResult('', 'mcp-server: listening on stdio\n'));
    await process.close();
    const result = await process.exited;

    expect(proc.closeCount).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.meta).toEqual({
      isolationLevel: 'full',
      backend: 'docker',
      degraded: false,
      degradationReasons: [],
    });
    // stderr stayed a separate diagnostic channel.
    expect(stderrText).toContain('listening on stdio');
  });
});
