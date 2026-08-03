// packages/sandbox/tests/vm/vsock-bridge.test.ts
// Unit test for the per-session vsock host bridge.
//
// Real AF_VSOCK needs the vsock kernel module + libkrun, so this test exercises
// only the unix-socket forwarding path with a stub loopback proxy server. The
// real AF_VSOCK end-to-end is exercised only at L3 (the vm-lane CI).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { VsockBridge } from '../../src/vm/vsock-bridge.js';

async function makeWorkDir() {
  return mkdtemp(join(tmpdir(), 'vsock-bridge-'));
}

async function startStubProxy(): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      socket.on('data', (data) => {
        socket.write(`echo:${data.toString()}`);
      });
      socket.on('end', () => socket.end());
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr !== 'object') {
        server.close(() => reject(new Error('stub proxy address unavailable')));
        return;
      }
      resolve({
        server,
        port: addr.port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

describe('VsockBridge', () => {
  let proxy: Awaited<ReturnType<typeof startStubProxy>> | undefined;

  beforeEach(async () => {
    proxy = await startStubProxy();
  });

  afterEach(async () => {
    await proxy?.close();
  });

  it('start returns a non-zero port and an absolute socket path', async () => {
    const workDir = await makeWorkDir();
    const bridge = new VsockBridge({ workDir, proxyHost: '127.0.0.1', proxyPort: proxy!.port });
    const result = await bridge.start();
    try {
      expect(result.vsockPort).toBeGreaterThan(0);
      expect(isAbsolute(result.vsockHostSocket)).toBe(true);
      expect(result.vsockHostSocket.startsWith(workDir)).toBe(true);
    } finally {
      await bridge.stop();
    }
  });

  it('forwards a connection on the unix socket to the stub proxy', async () => {
    const workDir = await makeWorkDir();
    const bridge = new VsockBridge({ workDir, proxyHost: '127.0.0.1', proxyPort: proxy!.port });
    const { vsockHostSocket } = await bridge.start();
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        const client = connect(vsockHostSocket);
        let buf = '';
        client.on('connect', () => client.write('hello'));
        client.on('data', (data: Buffer) => {
          buf += data.toString();
          if (buf.includes('echo:hello')) {
            client.end();
            resolve(buf);
          }
        });
        client.on('error', reject);
        client.on('timeout', () => reject(new Error('client timeout')));
        client.setTimeout(3000);
      });
      expect(reply).toBe('echo:hello');
    } finally {
      await bridge.stop();
    }
  });

  it('stop closes the server and unlinks the socket', async () => {
    const workDir = await makeWorkDir();
    const bridge = new VsockBridge({ workDir, proxyHost: '127.0.0.1', proxyPort: proxy!.port });
    const { vsockHostSocket } = await bridge.start();
    await bridge.stop();

    const client = connect(vsockHostSocket);
    const rejected = await new Promise<boolean>((resolve) => {
      client.on('error', () => resolve(true));
      client.on('connect', () => {
        client.end();
        resolve(false);
      });
      client.setTimeout(1000, () => resolve(true));
    });
    expect(rejected).toBe(true);
  });

  it('retries with a suffixed socket path when the default is EADDRINUSE', async () => {
    const workDir = await makeWorkDir();
    // Pre-occupy the default path with a live unix server so bind hits EADDRINUSE.
    const blocker = createServer();
    await new Promise<void>((res) => blocker.listen(join(workDir, 'vsock.sock'), () => res()));
    const bridge = new VsockBridge({ workDir, proxyHost: '127.0.0.1', proxyPort: proxy!.port });
    const result = await bridge.start();
    try {
      expect(result.vsockHostSocket.endsWith('.sock.1')).toBe(true);
      expect(result.vsockHostSocket.startsWith(workDir)).toBe(true);
    } finally {
      await bridge.stop();
      blocker.close();
    }
  });

  it('can restart after stop() resets internal state', async () => {
    const workDir = await makeWorkDir();
    const bridge = new VsockBridge({ workDir, proxyHost: '127.0.0.1', proxyPort: proxy!.port });
    await bridge.start();
    await bridge.stop();
    const again = await bridge.start();
    try {
      expect(again.vsockPort).toBeGreaterThan(0);
      expect(isAbsolute(again.vsockHostSocket)).toBe(true);
    } finally {
      await bridge.stop();
    }
  });
});
