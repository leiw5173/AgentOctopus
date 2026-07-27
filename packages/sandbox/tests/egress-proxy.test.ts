import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { EgressProxy } from '../src/proxy/egress-proxy.js';
import { SessionCa } from '../src/proxy/ca.js';
import type { SandboxPolicy } from '../src/policy.js';

let upstream: http.Server;
let upstreamPort: number;
let proxy: EgressProxy;
let proxyPort: number;

const policyFor = (hosts: string[]): SandboxPolicy => ({
  hosts,
  credentials: [],
  resources: { memoryBytes: 512 * 1024 * 1024, timeoutMs: 30000, cpus: 0.5 },
  denied: { hosts: [], credentials: [] },
});

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('upstream-ok');
  });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = (upstream.address() as any).port;
});

afterAll(async () => {
  await proxy?.close();
  upstream.close();
});

describe('EgressProxy (plain HTTP)', () => {
  it('forwards a granted host and 403s a denied host', async () => {
    proxy = new EgressProxy({
      policy: policyFor(['127.0.0.1']),
      secrets: {},
      ca: SessionCa.create(),
      explicitTargets: [{ scheme: 'http', host: '127.0.0.1', port: upstreamPort }],
    });
    proxyPort = await proxy.listen(0, '127.0.0.1');

    // Granted: 127.0.0.1 (IP literal explicitly granted in policy).
    const ok = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: proxyPort, method: 'GET',
        path: `http://127.0.0.1:${upstreamPort}/`,
      }, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toBe('upstream-ok');

    // Denied: example.com is not in policy.hosts.
    const denied = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: proxyPort, method: 'GET',
        path: `http://example.com/`,
      }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode! })); });
      req.on('error', reject);
      req.end();
    });
    expect(denied.status).toBe(403);
  });
});
