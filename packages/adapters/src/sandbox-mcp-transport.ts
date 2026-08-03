/**
 * Persistent duplex MCP transport over a sandboxed `SandboxProcess`
 * (Plan 5 Task 5).
 *
 * This replaces the legacy host stdio transport: the MCP child now runs
 * INSIDE the sandbox, spawned through the single execution boundary
 * (`BoundSandboxExecutionPort`, already skill-bound by core via
 * `sandboxRunner.bind(skill)`). Exactly ONE `port.spawn()` per `start()`;
 * exactly ONE process close per `close()`. One child stays alive across
 * initialize, notifications/initialized, tools/list, and MULTIPLE tools/call
 * requests.
 *
 * Framing is the shared leaf-package primitives (`frameMessage` /
 * `createFrameParser`) so every backend shares one parser. stderr is preserved
 * for diagnostics and NEVER mixed into the JSON-RPC stream.
 *
 * Leaf-package rule: this module imports ONLY the `@agentoctopus/sandbox`
 * contract/framing types and the SDK `Transport` type — never core/registry.
 */
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createFrameParser, frameMessage, MalformedFrameError } from '@agentoctopus/sandbox';
import type { BoundSandboxExecutionPort, SandboxSessionHandle } from './adapter.js';

export interface SandboxMcpTransportOptions {
  /** Skill-bound execution port injected by core — NOT a raw backend. */
  port: BoundSandboxExecutionPort;
  /** Guest command array (resolved MCP command split into argv). */
  command: string[];
  /** Optional minimal guest env (never the inherited host environment). */
  env?: Record<string, string>;
  timeoutMs: number;
}

export class SandboxMcpTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  private session: SandboxSessionHandle | undefined;
  private started = false;
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly opts: SandboxMcpTransportOptions) {}

  /** Exactly ONE port.spawn(); holds the returned SandboxSession. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const session = await this.opts.port.spawn({
      command: this.opts.command,
      invocation: this.opts.env ? { env: this.opts.env } : undefined,
      timeoutMs: this.opts.timeoutMs,
    });
    this.session = session;

    const process = session.process;

    // Incrementally parse newline-delimited JSON-RPC from stdout. Malformed
    // frames are surfaced via onerror (non-fatal) and never close the session.
    const parse = createFrameParser((message) => {
      this.onmessage?.(message as JSONRPCMessage);
    });
    process.stdout.on('data', (chunk: Uint8Array | string) => {
      try {
        parse(chunk);
      } catch (err) {
        if (err instanceof MalformedFrameError) {
          this.onerror?.(err);
        } else {
          this.onerror?.(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });

    // stderr is diagnostics-only — captured, never parsed into JSON-RPC.
    process.stderr.on('data', () => {
      /* intentionally discarded: diagnostics channel */
    });

    // When the child exits on its own, the transport is closed.
    void process.exited
      .then(() => this.handleProcessEnd())
      .catch((err) => {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
        return this.handleProcessEnd();
      });
  }

  /** Frame one JSON-RPC message onto the persistent child's stdin. */
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.session) throw new Error('SandboxMcpTransport not started');
    if (this.closed) throw new Error('SandboxMcpTransport is closed');
    const framed = frameMessage(message);
    await new Promise<void>((resolve, reject) => {
      this.session!.process.stdin.write(framed, (err?: Error | null) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  /** Close the process exactly once; the session owner cleans backend/proxy. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const session = this.session;
    this.session = undefined;
    this.closing = this.finishClose(session);
    return this.closing;
  }

  private async finishClose(session: SandboxSessionHandle | undefined): Promise<void> {
    try {
      await session?.close();
    } finally {
      this.onclose?.();
    }
  }

  /**
   * A peer exit closes the transport AND releases the runner-owned session.
   * Keeping cleanup here is essential: after the process has exited there may
   * be no later explicit close() call, and the session owns backend topology +
   * proxy teardown. close() memoizes the operation, so an explicit close racing
   * peer exit joins the same cleanup and onclose fires exactly once.
   */
  private async handleProcessEnd(): Promise<void> {
    try {
      await this.close();
    } catch (err) {
      this.onerror?.(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
