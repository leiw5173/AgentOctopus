import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { SessionCa } from '../src/proxy/ca.js';
import { createOneShotSecretWriter } from '../src/proxy/secret-channel.js';
import type { SandboxPolicy } from '../src/policy.js';
import type { ResolvedSecrets } from '../src/proxy/egress-proxy.js';

const entryPath = path.join(__dirname, '..', 'dist', 'egress-proxy-server.js');

function makePolicy(): SandboxPolicy {
  return {
    hosts: ['127.0.0.1'],
    credentials: [],
    resources: { memoryBytes: 512 * 1024 * 1024, timeoutMs: 30000, cpus: 0.5 },
    denied: { hosts: [], credentials: [] },
  };
}

function makeSecrets(): ResolvedSecrets {
  return { api_key: 'sk-test-abc123' };
}

describe('egress-proxy-server standalone', () => {
  let upstream: http.Server;
  let upstreamPort: number;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('upstream-ok');
    });
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
    upstreamPort = (upstream.address() as { port: number }).port;
  });

  afterAll(() => {
    upstream.close();
  });

  it('starts, reads one-shot frame, proxies one request, and exits 0 on SIGTERM', async () => {
    const ca = SessionCa.create();
    const writer = createOneShotSecretWriter({ secrets: makeSecrets(), ca });
    const secretStream = new PassThrough();

    const child = spawn(process.execPath, [entryPath], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: {
        OCTOPUS_PROXY_SECRET_FD: '3',
        OCTOPUS_PROXY_SECRET_NONCE: writer.nonce,
        OCTOPUS_PROXY_CONFIG: JSON.stringify({
          listenHost: '127.0.0.1',
          listenPort: 0,
          policy: makePolicy(),
          explicitTargets: [{ scheme: 'http', host: '127.0.0.1', port: upstreamPort }],
        }),
      },
    });

    // Write the one-shot frame on fd 3
    const fd3 = child.stdio[3] as NodeJS.WritableStream;
    await writer.writeTo(fd3);

    // Wait for ready JSON on stdout
    const ready = await new Promise<{ ready: boolean; boundPort: number }>((resolve, reject) => {
      let buf = '';
      const onData = (chunk: Buffer) => {
        buf += chunk.toString();
        try {
          const parsed = JSON.parse(buf.trim()) as { ready: boolean; boundPort: number };
          if (parsed.ready) {
            child.stdout!.off('data', onData);
            resolve(parsed);
          }
        } catch {
          // not yet complete JSON
        }
      };
      child.stdout!.on('data', onData);
      child.once('error', reject);
      setTimeout(() => reject(new Error('timeout waiting for ready')), 10_000);
    });

    expect(ready.ready).toBe(true);
    expect(ready.boundPort).toBeGreaterThan(0);

    // Make one proxy request
    const proxyRes = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: ready.boundPort,
        method: 'GET',
        path: `http://127.0.0.1:${upstreamPort}/`,
      }, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(proxyRes.status).toBe(200);
    expect(proxyRes.body).toBe('upstream-ok');

    // Second frame/write should be rejected (stream already closed)
    expect(fd3.destroyed || (fd3 as { writableEnded?: boolean }).writableEnded).toBe(true);

    // SIGTERM → exit 0
    const exitPromise = new Promise<number>((resolve) => {
      child.on('close', (code) => resolve(code ?? -1));
    });
    child.kill('SIGTERM');
    const exitCode = await exitPromise;
    expect(exitCode).toBe(0);

    ca.destroy();
  }, 15_000);

  it('fails closed on wrong nonce', async () => {
    const ca = SessionCa.create();
    const writer = createOneShotSecretWriter({ secrets: makeSecrets(), ca });
    const secretStream = new PassThrough();

    const child = spawn(process.execPath, [entryPath], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: {
        OCTOPUS_PROXY_SECRET_FD: '3',
        OCTOPUS_PROXY_SECRET_NONCE: '0'.repeat(64), // wrong nonce
        OCTOPUS_PROXY_CONFIG: JSON.stringify({
          listenHost: '127.0.0.1',
          listenPort: 0,
          policy: makePolicy(),
        }),
      },
    });

    const fd3 = child.stdio[3] as NodeJS.WritableStream;
    await writer.writeTo(fd3);

    const exitCode = await new Promise<number>((resolve) => {
      child.on('close', (code) => resolve(code ?? -1));
    });
    expect(exitCode).not.toBe(0);
    ca.destroy();
  }, 15_000);
});
