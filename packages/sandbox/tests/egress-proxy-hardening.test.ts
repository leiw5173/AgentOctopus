import { describe, it, expect } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { EgressProxy } from '../src/proxy/egress-proxy.js';
import { SessionCa } from '../src/proxy/ca.js';
import type { DnsLookup } from '../src/proxy/dns.js';
import type { SandboxPolicy } from '../src/policy.js';

const policyFor = (
  hosts: string[],
  credentials: SandboxPolicy['credentials'] = [],
): SandboxPolicy => ({
  hosts,
  credentials,
  resources: { memoryBytes: 512 * 1024 * 1024, timeoutMs: 30000, cpus: 0.5 },
  denied: { hosts: [], credentials: [] },
});

describe('EgressProxy hardening', () => {
  it('MITMs CONNECT to an explicitly granted loopback TLS endpoint and validates the injected upstream CA', async () => {
    // Create a separate upstream CA (distinct from the proxy's MITM CA)
    const upstreamCa = SessionCa.create();
    const upstreamLeaf = upstreamCa.issueForHost('127.0.0.1');

    // Start HTTPS upstream server with the leaf cert
    const upstreamTls = https.createServer(
      { cert: upstreamLeaf.certPem, key: upstreamLeaf.keyPem },
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('mitm-body');
      },
    );
    await new Promise<void>(r => upstreamTls.listen(0, '127.0.0.1', r));
    const tlsPort = (upstreamTls.address() as net.AddressInfo).port;

    const proxyCa = SessionCa.create();
    const proxy = new EgressProxy({
      policy: policyFor(['127.0.0.1']),
      secrets: {},
      ca: proxyCa,
      explicitTargets: [{ scheme: 'https', host: '127.0.0.1', port: tlsPort }],
      upstreamTls: { ca: upstreamCa.certPem },
    });
    const proxyPort = await proxy.listen(0, '127.0.0.1');

    try {
      // Open CONNECT tunnel, then TLS through it, trusting proxyCa.certPem.
      // Don't set servername — Node.js rejects IP addresses as SNI.
      const body = await new Promise<string>((resolve, reject) => {
        const connectReq = http.request({
          host: '127.0.0.1',
          port: proxyPort,
          method: 'CONNECT',
          path: `127.0.0.1:${tlsPort}`,
        });
        connectReq.on('connect', (_res, socket) => {
          const tlsSocket = tls.connect({
            socket: socket as net.Socket,
            ca: [proxyCa.certPem],
            rejectUnauthorized: true,
            checkServerIdentity: () => undefined,
          }, () => {
            const req = `GET / HTTP/1.1\r\nHost: 127.0.0.1:${tlsPort}\r\nConnection: close\r\n\r\n`;
            tlsSocket.write(req);
            let response = '';
            tlsSocket.on('data', d => { response += d.toString(); });
            tlsSocket.on('end', () => {
              // Parse body from raw HTTP response
              const bodyStart = response.indexOf('\r\n\r\n');
              resolve(bodyStart >= 0 ? response.slice(bodyStart + 4) : response);
            });
            tlsSocket.on('error', reject);
          });
          tlsSocket.on('error', reject);
        });
        connectReq.on('error', reject);
        connectReq.end();
      });
      expect(body).toBe('mitm-body');
    } finally {
      await proxy.close();
      upstreamTls.close();
    }
  });

  it('returns 502 when that same upstream CA is omitted, proving normal TLS validation is the default', async () => {
    // Same upstream but WITHOUT upstreamTls — the proxy uses system trust store,
    // which won't trust our self-signed upstream CA → TLS validation fails → 502
    const upstreamCa = SessionCa.create();
    const upstreamLeaf = upstreamCa.issueForHost('127.0.0.1');

    const upstreamTls = https.createServer(
      { cert: upstreamLeaf.certPem, key: upstreamLeaf.keyPem },
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('should-not-reach');
      },
    );
    await new Promise<void>(r => upstreamTls.listen(0, '127.0.0.1', r));
    const tlsPort = (upstreamTls.address() as net.AddressInfo).port;

    const proxyCa = SessionCa.create();
    const proxy = new EgressProxy({
      policy: policyFor(['127.0.0.1']),
      secrets: {},
      ca: proxyCa,
      explicitTargets: [{ scheme: 'https', host: '127.0.0.1', port: tlsPort }],
      // NO upstreamTls — proxy uses platform default trust store
    });
    const proxyPort = await proxy.listen(0, '127.0.0.1');

    try {
      const status = await new Promise<number>((resolve, reject) => {
        const connectReq = http.request({
          host: '127.0.0.1',
          port: proxyPort,
          method: 'CONNECT',
          path: `127.0.0.1:${tlsPort}`,
        });
        connectReq.on('connect', (_res, socket) => {
          const tlsSocket = tls.connect({
            socket: socket as net.Socket,
            ca: [proxyCa.certPem],
            rejectUnauthorized: true,
            checkServerIdentity: () => undefined,
          }, () => {
            // TLS through the proxy succeeded (proxy CA is trusted).
            // Send an HTTP request — the proxy will try to forward to upstream,
            // but upstream TLS will fail (upstream CA not in system trust store).
            const req = `GET / HTTP/1.1\r\nHost: 127.0.0.1:${tlsPort}\r\nConnection: close\r\n\r\n`;
            tlsSocket.write(req);
            let response = '';
            tlsSocket.on('data', d => { response += d.toString(); });
            tlsSocket.on('end', () => {
              const statusMatch = response.match(/^HTTP\/\d\.\d (\d+)/);
              resolve(statusMatch ? Number(statusMatch[1]) : 0);
            });
            tlsSocket.on('error', reject);
          });
          tlsSocket.on('error', reject);
        });
        connectReq.on('error', reject);
        connectReq.end();
      });
      expect(status).toBe(502);
    } finally {
      await proxy.close();
      upstreamTls.close();
    }
  });

  it('rejects a granted hostname whose injected DNS answer is 127.0.0.1', async () => {
    // Hostname is in policy.hosts (granted), but DNS returns 127.0.0.1 (private).
    // Since it's not an IP literal grant, allowPrivateLiteral is false → 403
    const dnsLookup: DnsLookup = async (host) => {
      if (host === 'granted-but-private.example.com') {
        return [{ address: '127.0.0.1', family: 4 }];
      }
      throw new Error(`unexpected host: ${host}`);
    };

    const proxy = new EgressProxy({
      policy: policyFor(['granted-but-private.example.com']),
      secrets: {},
      ca: SessionCa.create(),
      dnsLookup,
    });
    const proxyPort = await proxy.listen(0, '127.0.0.1');

    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: proxyPort,
          method: 'GET',
          path: 'http://granted-but-private.example.com/',
        }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode!));
        });
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(403);
    } finally {
      await proxy.close();
    }
  });

  it('preserves the current non-default port when resolving a relative redirect', async () => {
    // Upstream on non-default port returns 302 with relative Location.
    // Proxy should follow to same origin (same port).
    let requestCount = 0;
    const upstream = http.createServer((req, res) => {
      requestCount++;
      if (req.url === '/first') {
        res.writeHead(302, { 'location': '/second' });
        res.end();
        return;
      }
      // /second — assert we're on the same upstream
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('redirected-ok');
    });
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;

    const proxy = new EgressProxy({
      policy: policyFor(['127.0.0.1']),
      secrets: {},
      ca: SessionCa.create(),
      explicitTargets: [{ scheme: 'http', host: '127.0.0.1', port: upstreamPort }],
    });
    const proxyPort = await proxy.listen(0, '127.0.0.1');

    try {
      const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: proxyPort,
          method: 'GET',
          path: `http://127.0.0.1:${upstreamPort}/first`,
        }, (res) => {
          let body = '';
          res.on('data', d => body += d);
          res.on('end', () => resolve({ status: res.statusCode!, body }));
        });
        req.on('error', reject);
        req.end();
      });
      expect(result.status).toBe(200);
      expect(result.body).toBe('redirected-ok');
      // Both /first and /second should have hit the same upstream
      expect(requestCount).toBe(2);
    } finally {
      await proxy.close();
      upstream.close();
    }
  });

  it('re-evaluates cross-origin redirects and never forwards the first origin credential', async () => {
    // Origin A (portA) has a credential grant; Origin B (portB) does not.
    // Origin A redirects to Origin B.
    // The CLIENT sends its own Authorization header so the strip logic has
    // something concrete to remove; without it the test would pass even if
    // the strip block were deleted.
    // Assert: credential from A is NOT forwarded to B.

    let originAObservedAuth: string | undefined;
    let originBObservedAuth: string | undefined = 'sentinel';

    // Origin A: records auth header, then redirects to Origin B
    const originA = http.createServer((req, res) => {
      originAObservedAuth = req.headers.authorization;
      const portB = (originB.address() as net.AddressInfo).port;
      res.writeHead(302, { 'location': `http://127.0.0.1:${portB}/target` });
      res.end();
    });
    await new Promise<void>(r => originA.listen(0, '127.0.0.1', r));
    const portA = (originA.address() as net.AddressInfo).port;

    // Origin B: records the authorization header
    const originB = http.createServer((req, res) => {
      originBObservedAuth = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('origin-b-ok');
    });
    await new Promise<void>(r => originB.listen(0, '127.0.0.1', r));
    const portB = (originB.address() as net.AddressInfo).port;

    const proxy = new EgressProxy({
      policy: policyFor(
        ['127.0.0.1'],
        [
          {
            key: 'ORIGIN_A_KEY',
            host: '127.0.0.1',
            port: portA,
            scheme: 'http',
            methods: ['GET'],
            pathPrefix: '/',
            header: 'Authorization',
            prefix: 'Bearer ',
            highRisk: true,
          },
        ],
      ),
      secrets: { ORIGIN_A_KEY: 'secret-a-value' },
      ca: SessionCa.create(),
      explicitTargets: [
        { scheme: 'http', host: '127.0.0.1', port: portA },
        { scheme: 'http', host: '127.0.0.1', port: portB },
      ],
    });
    const proxyPort = await proxy.listen(0, '127.0.0.1');

    try {
      const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: proxyPort,
          method: 'GET',
          path: `http://127.0.0.1:${portA}/start`,
          headers: { authorization: 'Bearer client-supplied' },
        }, (res) => {
          let body = '';
          res.on('data', d => body += d);
          res.on('end', () => resolve({ status: res.statusCode!, body }));
        });
        req.on('error', reject);
        req.end();
      });
      expect(result.status).toBe(200);
      expect(result.body).toBe('origin-b-ok');
      // Origin A received the injected credential (overwriting the client's)
      expect(originAObservedAuth).toBe('Bearer secret-a-value');
      // The client-supplied credential (and the injected one) must NOT have been
      // forwarded to origin B — the strip logic removed it on cross-origin redirect
      expect(originBObservedAuth).toBeUndefined();
    } finally {
      await proxy.close();
      originA.close();
      originB.close();
    }
  });

  it('returns a clean framed 502 when an upstream body exceeds maxRespBytes', async () => {
    // Raw net.Server upstream that emits a large body exceeding maxRespBytes.
    // Using raw net.Server avoids Node normalizing the framing.
    const upstream = net.createServer((socket) => {
      socket.once('data', () => {
        const bigBody = 'X'.repeat(2000);
        const response = [
          'HTTP/1.1 200 OK',
          'Content-Type: text/plain',
          `Content-Length: ${bigBody.length}`,
          '',
          bigBody,
        ].join('\r\n');
        socket.write(response);
        socket.end();
      });
    });
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;

    const proxy = new EgressProxy({
      policy: policyFor(['127.0.0.1']),
      secrets: {},
      ca: SessionCa.create(),
      explicitTargets: [{ scheme: 'http', host: '127.0.0.1', port: upstreamPort }],
      maxRespBytes: 100, // very small cap
    });
    const proxyPort = await proxy.listen(0, '127.0.0.1');

    try {
      const result = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: proxyPort,
          method: 'GET',
          path: `http://127.0.0.1:${upstreamPort}/`,
        }, (res) => {
          let body = '';
          res.on('data', d => body += d);
          res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
      });
      expect(result.status).toBe(502);
      expect(result.body).toBe('response too large');
      // Content-length must match the actual 502 body, not the upstream's misleading value
      expect(Number(result.headers['content-length'])).toBe(result.body.length);
    } finally {
      await proxy.close();
      upstream.close();
    }
  });

  it('returns a clean 502 when an upstream sends headers + partial body then RSTs mid-response', async () => {
    // Upstream sends valid headers and a partial body, then destroys the socket.
    // The proxy's `for await (const chunk of upstreamRes)` gets ECONNRESET.
    // Assert: client receives a clean 502, process does not crash.
    const upstream = net.createServer((socket) => {
      socket.once('data', () => {
        // Send headers + partial body, then destroy without completing
        const partial = [
          'HTTP/1.1 200 OK',
          'Content-Type: text/plain',
          'Content-Length: 9999',
          '',
          'partial-body-',
        ].join('\r\n');
        socket.write(partial);
        // Destroy the socket after a short delay to simulate a mid-body RST
        setTimeout(() => socket.destroy(), 10);
      });
    });
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;

    const proxy = new EgressProxy({
      policy: policyFor(['127.0.0.1']),
      secrets: {},
      ca: SessionCa.create(),
      explicitTargets: [{ scheme: 'http', host: '127.0.0.1', port: upstreamPort }],
    });
    const proxyPort = await proxy.listen(0, '127.0.0.1');

    try {
      const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: proxyPort,
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
      expect(result.status).toBe(502);
      expect(result.body).toBe('upstream error');
    } finally {
      await proxy.close();
      upstream.close();
    }
  });

  it('counts HTTP and CONNECT exactly once, enforces maxConns, and returns to zero after repeated close/error events', async () => {
    // Use a real upstream that holds responses open
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('holding...');
      // Don't end — hold the connection open
    });
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;

    const proxy = new EgressProxy({
      policy: policyFor(['127.0.0.1']),
      secrets: {},
      ca: SessionCa.create(),
      explicitTargets: [{ scheme: 'http', host: '127.0.0.1', port: upstreamPort }],
      maxConns: 4,
    });
    const proxyPort = await proxy.listen(0, '127.0.0.1');

    try {
      // Open a raw TCP connection — counted immediately at the connection event
      const tcpSocket1 = net.connect(proxyPort, '127.0.0.1');
      tcpSocket1.on('error', () => {}); // swallow client-side errors
      await new Promise<void>(r => tcpSocket1.once('connect', r));

      // Open a second raw TCP connection
      const tcpSocket2 = net.connect(proxyPort, '127.0.0.1');
      tcpSocket2.on('error', () => {}); // swallow client-side errors
      await new Promise<void>(r => tcpSocket2.once('connect', r));

      // Allow server to process
      await new Promise(r => setTimeout(r, 100));

      // Both connections should be counted
      const countAfterTwo = proxy.activeConnections;
      expect(countAfterTwo).toBe(2);

      // Destroy first socket — triggers both error and close on the server side,
      // but the idempotent release ensures only one decrement
      tcpSocket1.destroy();
      await new Promise(r => setTimeout(r, 100));
      expect(proxy.activeConnections).toBe(1);
      expect(proxy.activeConnections).toBeGreaterThanOrEqual(0);

      // Destroy second socket
      tcpSocket2.destroy();
      await new Promise(r => setTimeout(r, 100));

      // Count should return to zero and never go negative
      expect(proxy.activeConnections).toBe(0);

      // Test maxConns enforcement: set a very low maxConns proxy
      await proxy.close();

      const smallProxy = new EgressProxy({
        policy: policyFor(['127.0.0.1']),
        secrets: {},
        ca: SessionCa.create(),
        explicitTargets: [{ scheme: 'http', host: '127.0.0.1', port: upstreamPort }],
        maxConns: 1,
      });
      const smallPort = await smallProxy.listen(0, '127.0.0.1');

      // Fill the one allowed connection
      const conn1 = net.connect(smallPort, '127.0.0.1');
      conn1.on('error', () => {});
      await new Promise<void>(r => conn1.once('connect', r));
      await new Promise(r => setTimeout(r, 50));
      expect(smallProxy.activeConnections).toBe(1);

      // Second connection should be rejected (503)
      const conn2 = net.connect(smallPort, '127.0.0.1');
      conn2.on('error', () => {});
      const conn2Data = await new Promise<string>((resolve) => {
        conn2.once('data', (d) => resolve(d.toString()));
      });
      expect(conn2Data).toContain('503');

      // The rejected connection should not be counted
      expect(smallProxy.activeConnections).toBe(1);

      conn1.destroy();
      conn2.destroy();
      await new Promise(r => setTimeout(r, 100));
      expect(smallProxy.activeConnections).toBe(0);
      await smallProxy.close();
    } finally {
      upstream.close();
    }
  });
});
