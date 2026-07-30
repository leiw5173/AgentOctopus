// packages/sandbox/src/vm/vsock-bridge.ts
// Per-session AF_VSOCK host bridge.
//
// libkrun's krun_add_vsock_port(ctx, port, hostSocket) connects the guest's
// vsock CID:port to a HOST unix-domain socket at hostSocket. This module binds
// a Node net.Server on that unix socket and forwards each accepted connection
// to the in-process egress proxy's loopback address (127.0.0.1:<proxyPort>).
//
// The guest opens AF_VSOCK connections to CID:2 (host) on vsockPort; libkrun
// bridges those to the host socket; this server then proxies bytes to/from the
// egress proxy. Real AF_VSOCK needs the vsock kernel module + libkrun, so the
// L1/L2 unit tests below exercise only the unix-socket forwarding path with a
// stub proxy listener. The real AF_VSOCK end-to-end is exercised only at L3
// (the vm-lane CI).
import { connect, createServer, type Server, type Socket } from 'node:net';
import { unlink } from 'node:fs/promises';
import path from 'node:path';

export interface VsockBridgeOptions {
  /** Backend-owned per-session workDir, already created with 0700 mode. */
  workDir: string;
  /** Loopback address the in-process egress proxy listens on (usually 127.0.0.1). */
  proxyHost: string;
  /** Loopback port the in-process egress proxy listens on. */
  proxyPort: number;
}

export interface VsockBridgeStartResult {
  /** Non-zero vsock port the guest uses to reach the host (CID:2). */
  vsockPort: number;
  /** Absolute path to the host unix-domain socket libkrun connects to. */
  vsockHostSocket: string;
}

let bridgeCounter = 0;

/** Deterministic per-session port that avoids collisions across processes. */
function allocateVsockPort(): number {
  const base = 1024;
  const range = 30000;
  const n = bridgeCounter++;
  return base + ((process.pid + n) % range);
}

export class VsockBridge {
  private server?: Server;
  private socketPath?: string;
  private vsockPort?: number;
  private closed = false;

  constructor(private readonly opts: VsockBridgeOptions) {}

  async start(): Promise<VsockBridgeStartResult> {
    if (this.server) {
      throw new Error('VsockBridge.start() called twice');
    }
    this.closed = false;
    const port = allocateVsockPort();
    const server = createServer((clientSocket) => this.onConnection(clientSocket));
    this.server = server;
    this.vsockPort = port;
    const socketPath = path.resolve(this.opts.workDir, 'vsock.sock');
    await this.bindWithRetry(socketPath);
    return { vsockPort: port, vsockHostSocket: this.socketPath! };
  }

  // Each bind attempt uses a FRESH Server: after a failed listen() the same
  // Server instance is not reliably reusable across all error conditions.
  private async bindWithRetry(socketPath: string, attempts = 3): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      const tryPath = i === 0 ? socketPath : `${socketPath}.${i}`;
      const server = createServer((clientSocket) => this.onConnection(clientSocket));
      try {
        await new Promise<void>((resolve, reject) => {
          const onErr = (err: Error) => {
            server.off('error', onErr);
            reject(err);
          };
          server.once('error', onErr);
          server.listen(tryPath, () => {
            server.off('error', onErr);
            this.socketPath = tryPath;
            resolve();
          });
        });
        this.server = server;
        return;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        const isAddrInUse = code === 'EADDRINUSE';
        await this.tryUnlink(tryPath);
        if (!isAddrInUse || i === attempts - 1) {
          throw new Error(
            `VsockBridge failed to bind unix socket ${tryPath}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
    throw new Error('VsockBridge bindWithRetry exhausted attempts');
  }

  private onConnection(clientSocket: Socket): void {
    const proxySocket = connect(this.opts.proxyPort, this.opts.proxyHost, () => {
      clientSocket.pipe(proxySocket);
      proxySocket.pipe(clientSocket);
    });

    proxySocket.on('error', (err) => {
      clientSocket.destroy(err);
    });
    clientSocket.on('error', (err) => {
      proxySocket.destroy(err);
    });
    proxySocket.on('close', () => {
      clientSocket.destroy();
    });
    clientSocket.on('close', () => {
      proxySocket.destroy();
    });
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const server = this.server;
    const socketPath = this.socketPath;
    // Reset state so the instance can be restarted via start().
    this.server = undefined;
    this.socketPath = undefined;
    this.vsockPort = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Force resolve if close hangs (e.g. stale connections).
      setTimeout(resolve, 500);
    });
    if (socketPath) {
      await this.tryUnlink(socketPath);
    }
  }

  private async tryUnlink(socketPath: string): Promise<void> {
    try {
      await unlink(socketPath);
    } catch {
      // best-effort
    }
  }
}
