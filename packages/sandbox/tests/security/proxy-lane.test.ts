/**
 * Plan 6 Task 4 — Egress proxy adversarial matrix.
 *
 * Tests the full policy, redirect, framing, DNS, connection-accounting,
 * raw-header smuggling, and TLS MITM behavior of the egress proxy against REAL
 * local HTTP/TLS/DNS fixtures on 127.0.0.1 (no Docker required for this lane).
 *
 * Leaf-package rule: imports only Node stdlib + this package's own src + the
 * node-forge test CA. No @agentoctopus/{core,registry,adapters,skills}.
 *
 * Secret hygiene: the test secret is NEVER written into a snapshot, test name,
 * or failure message. Assertions compare against the expected credential shape
 * (`Bearer <redacted>` invariants) and record only booleans/counts, never the
 * raw secret value, in any observable output.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import forge from 'node-forge';
import { EgressProxy, type UpstreamConnector } from '../../src/proxy/egress-proxy.js';
import { SessionCa } from '../../src/proxy/ca.js';
import type { DnsLookup } from '../../src/proxy/dns.js';
import type { SandboxPolicy } from '../../src/policy.js';
import type { CredentialGrant } from '../../src/schema.js';

// The test secret value. Used only to CONSTRUCT the proxy and to compare
// against the upstream-observed Authorization header — never interpolated into
// a test name, snapshot, or custom failure message.
const TEST_SECRET = 'test-secret';
const TEST_AUTH = `Bearer ${TEST_SECRET}`;

const MAX_RESP_BYTES = 1024; // small cap so oversized fixtures are cheap

// ---------------------------------------------------------------------------
// Cleanup registry — every fixture/proxy opened by a test is closed here so a
// failing assertion never leaks a listening socket into the next case.
// ---------------------------------------------------------------------------
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) {
    const fn = cleanups.pop()!;
    try { await fn(); } catch { /* best-effort */ }
  }
});

function track<T extends { close(cb?: () => void): void }>(server: T): T {
  cleanups.push(() => new Promise<void>(r => server.close(() => r())));
  return server;
}
function trackProxy(p: EgressProxy): EgressProxy {
  cleanups.push(() => p.close());
  return p;
}

// ---------------------------------------------------------------------------
// Policy builder
// ---------------------------------------------------------------------------
function policyFor(hosts: string[], credentials: CredentialGrant[] = []): SandboxPolicy {
  return {
    hosts,
    credentials,
    resources: { memoryBytes: 512 * 1024 * 1024, timeoutMs: 30_000, cpus: 0.5 },
    denied: { hosts: [], credentials: [] },
  };
}

// ---------------------------------------------------------------------------
// Recording upstream
//
// Records { method, url, host, rawHeaders, authorization, socketAddress } for
// the most recent request. NEVER records the raw secret in a way that would
// surface in a snapshot — `authorization` holds whatever arrived, but tests
// only assert equality against the expected shape, never print it.
// ---------------------------------------------------------------------------
interface RecordedRequest {
  method: string;
  url: string;
  host: string | undefined;
  rawHeaders: string[];
  authorization: string | undefined;
  socketAddress: string | undefined;
  /** Count of `authorization` header occurrences in rawHeaders (case-insensitive). */
  authorizationHeaderCount: number;
}

class RecordingUpstream {
  public server: http.Server;
  public last: RecordedRequest | null = null;
  public count = 0;
  public port = 0;
  private handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  constructor(
    responder?: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ) {
    this.handler = responder ?? ((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('upstream-ok');
    });
    this.server = track(http.createServer((req, res) => {
      this.count++;
      const rawHeaders = [...req.rawHeaders];
      this.last = {
        method: req.method ?? '',
        url: req.url ?? '',
        host: req.headers.host,
        rawHeaders,
        authorization: req.headers.authorization,
        socketAddress: req.socket.remoteAddress,
        authorizationHeaderCount: rawHeaders.filter(
          (_v, i) => i % 2 === 0 && rawHeaders[i]!.toLowerCase() === 'authorization',
        ).length,
      };
      this.handler(req, res);
    }));
  }

  async listen(): Promise<number> {
    await new Promise<void>(r => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this.port;
  }
}

// ---------------------------------------------------------------------------
// Test upstream CA (distinct from the proxy's MITM session CA)
// ---------------------------------------------------------------------------
interface TestUpstreamCa {
  caCert: string;
  caKey: string;
  serverCert: string;
  serverKey: string;
}

/**
 * Returns { caCert, caKey, serverCert, serverKey }; the server leaf carries
 * subjectAltName [{ type: 7, ip: '127.0.0.1' }] so IP-literal upstream
 * validation succeeds. Start the TLS upstream with serverCert/serverKey; start
 * the proxy with upstreamTls: { ca: caCert }.
 */
function createTestUpstreamCa(): TestUpstreamCa {
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const ca = forge.pki.createCertificate();
  ca.publicKey = caKeys.publicKey;
  ca.serialNumber = '01';
  ca.validity.notBefore = new Date();
  ca.validity.notAfter = new Date(Date.now() + 24 * 3600 * 1000);
  const caAttrs = [{ name: 'commonName', value: 'AgentOctopus Test Upstream CA' }];
  ca.setSubject(caAttrs);
  ca.setIssuer(caAttrs);
  ca.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
  ]);
  ca.sign(caKeys.privateKey, forge.md.sha256.create());

  const srvKeys = forge.pki.rsa.generateKeyPair(2048);
  const leaf = forge.pki.createCertificate();
  leaf.publicKey = srvKeys.publicKey;
  leaf.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(8));
  leaf.validity.notBefore = new Date();
  leaf.validity.notAfter = new Date(Date.now() + 24 * 3600 * 1000);
  leaf.setSubject([{ name: 'commonName', value: '127.0.0.1' }]);
  leaf.setIssuer(ca.subject.attributes);
  leaf.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] },
  ]);
  leaf.sign(caKeys.privateKey, forge.md.sha256.create());

  return {
    caCert: forge.pki.certificateToPem(ca),
    caKey: forge.pki.privateKeyToPem(caKeys.privateKey),
    serverCert: forge.pki.certificateToPem(leaf),
    serverKey: forge.pki.privateKeyToPem(srvKeys.privateKey),
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  complete: boolean;
  rawResponse: string;
}

/** Send an absolute-form request through the proxy and buffer the full reply. */
function requestViaProxy(opts: {
  proxyPort: number;
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: opts.proxyPort,
      method: opts.method ?? 'GET',
      path: opts.url,
      headers: opts.headers,
      // No keepalive pooling — a pooled global-agent socket would hold a proxy
      // connection slot open after the response and corrupt accounting tests.
      agent: false,
    }, (res) => {
      const chunks: Buffer[] = [];
      let raw = '';
      res.on('data', (d: Buffer) => { chunks.push(d); raw += d.toString('latin1'); });
      res.on('end', () => resolve({
        status: res.statusCode!,
        headers: res.headers,
        body: Buffer.concat(chunks),
        complete: res.complete,
        rawResponse: `${res.statusCode} ${JSON.stringify(res.headers)} ${raw}`,
      }));
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Send raw bytes to the proxy and capture the status line of the reply. */
function sendRawToProxy(proxyPort: number, raw: Buffer | string): Promise<{ status: number; head: string; raw: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => socket.write(raw));
    let buf = '';
    socket.on('data', d => { buf += d.toString('latin1'); });
    socket.on('error', () => {});
    const finish = () => {
      const head = buf.split('\r\n\r\n')[0] ?? buf;
      const m = /^HTTP\/\d\.\d (\d+)/.exec(head);
      resolve({ status: m ? Number(m[1]) : 0, head, raw: buf });
    };
    socket.on('close', finish);
    socket.on('end', finish);
    setTimeout(() => { socket.destroy(); }, 700).unref();
  });
}

/** Open a CONNECT tunnel; resolves with the established socket (or status). */
function openConnect(proxyPort: number, authority: string): Promise<{ status: number; socket?: net.Socket }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: authority,
    });
    req.on('connect', (res, socket) => resolve({ status: res.statusCode!, socket: socket as net.Socket }));
    req.on('error', reject);
    // A non-2xx CONNECT reply arrives as a normal response.
    req.on('response', (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode! })); });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Deterministic resolver + connector for the DNS lane
// ---------------------------------------------------------------------------
class FakeResolver {
  private table = new Map<string, string[]>();
  private sequences = new Map<string, string[][]>();
  private callCounts = new Map<string, number>();

  set(host: string, ips: string[]): void { this.table.set(host, ips); }
  sequence(host: string, seq: string[][]): void { this.sequences.set(host, [...seq]); }
  calls(host: string): number { return this.callCounts.get(host) ?? 0; }

  readonly lookup: DnsLookup = async (host) => {
    this.callCounts.set(host, (this.callCounts.get(host) ?? 0) + 1);
    const seq = this.sequences.get(host);
    if (seq && seq.length > 0) {
      const next = seq.shift()!;
      return next.map(address => ({ address, family: (net.isIP(address) || 4) as 4 | 6 }));
    }
    const ips = this.table.get(host);
    if (!ips) throw new Error(`DNS: no answer for ${host}`);
    return ips.map(address => ({ address, family: (net.isIP(address) || 4) as 4 | 6 }));
  };
}

// ---------------------------------------------------------------------------
// Policy matrix
// ---------------------------------------------------------------------------
describe('egress proxy policy matrix', () => {
  it.each([
    ['HTTP absolute-form', 'http'],
    ['CONNECT', 'connect'],
  ])('returns 403 for a non-granted target over %s', async (_name, kind) => {
    const upstream = new RecordingUpstream();
    const upstreamPort = await upstream.listen();
    void upstreamPort;
    const proxy = trackProxy(new EgressProxy({
      policy: policyFor(['granted.example']),
      secrets: {},
      ca: SessionCa.create(),
    }));
    const proxyPort = await proxy.listen(0, '127.0.0.1');

    if (kind === 'http') {
      const r = await requestViaProxy({ proxyPort, url: 'http://denied.invalid/' });
      expect(r.status).toBe(403);
    } else {
      const c = await openConnect(proxyPort, 'denied.invalid:443');
      c.socket?.destroy();
      expect(c.status).toBe(403);
    }
    expect(upstream.count).toBe(0);
  });

  it('injects a string credential on an exact scheme+host+port+method+path match and overwrites attacker input', async () => {
    const upstream = new RecordingUpstream();
    const upstreamPort = await upstream.listen();
    const grant: CredentialGrant = {
      key: 'UPSTREAM_API_KEY',
      host: '127.0.0.1',
      port: upstreamPort,
      scheme: 'http',
      methods: ['GET'],
      pathPrefix: '/secure',
      header: 'Authorization',
      prefix: 'Bearer ',
      highRisk: true,
    };
    const proxy = trackProxy(new EgressProxy({
      policy: policyFor(['127.0.0.1'], [grant]),
      secrets: { UPSTREAM_API_KEY: TEST_SECRET },
      ca: SessionCa.create(),
      explicitTargets: [{ scheme: 'http', host: '127.0.0.1', port: upstreamPort }],
    }));
    const proxyPort = await proxy.listen(0, '127.0.0.1');

    const r = await requestViaProxy({
      proxyPort,
      url: `http://127.0.0.1:${upstreamPort}/secure/data`,
      headers: { authorization: 'Bearer attacker' },
    });
    expect(r.status).toBe(200);
    expect(upstream.last).not.toBeNull();
    // The injected credential OVERWROTE the attacker-supplied header.
    expect(upstream.last!.authorization).toBe(TEST_AUTH);
    // Exactly ONE authorization header reached the upstream (no duplicates).
    expect(upstream.last!.authorizationHeaderCount).toBe(1);
  });

  it.each([
    ['method', { method: 'POST', path: '/secure/data', useGrantedPort: true, scheme: 'http' as const }],
    ['path', { method: 'GET', path: '/public', useGrantedPort: true, scheme: 'http' as const }],
    ['port', { method: 'GET', path: '/secure/data', useGrantedPort: false, scheme: 'http' as const }],
    ['scheme', { method: 'GET', path: '/secure/data', useGrantedPort: true, scheme: 'https' as const }],
  ])('does not inject when %s is outside the credential grant', async (_name, variant) => {
    const upstream = new RecordingUpstream();
    const upstreamPort = await upstream.listen();
    const otherUpstream = new RecordingUpstream();
    const otherPort = await otherUpstream.listen();

    const grant: CredentialGrant = {
      key: 'UPSTREAM_API_KEY',
      host: '127.0.0.1',
      port: upstreamPort,
      scheme: 'http',
      methods: ['GET'],
      pathPrefix: '/secure',
      header: 'Authorization',
      prefix: 'Bearer ',
      highRisk: true,
    };
    const proxy = trackProxy(new EgressProxy({
      policy: policyFor(['127.0.0.1'], [grant]),
      secrets: { UPSTREAM_API_KEY: TEST_SECRET },
      ca: SessionCa.create(),
      explicitTargets: [
        { scheme: 'http', host: '127.0.0.1', port: upstreamPort },
        { scheme: 'http', host: '127.0.0.1', port: otherPort },
        // scheme variant forwards plain-HTTP to the granted port; the credential
        // grant is scheme:http but the *target* we construct below is still
        // http. To exercise a scheme mismatch we rely on the grant being http
        // and probe a target whose scheme differs — handled below.
      ],
    }));
    const proxyPort = await proxy.listen(0, '127.0.0.1');

    const targetPort = variant.useGrantedPort ? upstreamPort : otherPort;
    const active = variant.useGrantedPort ? upstream : otherUpstream;
    // scheme:https against a plain-HTTP upstream will fail the TLS handshake —
    // that still proves the credential was NOT injected into a successful
    // upstream request. We assert on the recorded upstream only for http.
    const url = `${variant.scheme}://127.0.0.1:${targetPort}${variant.path}`;
    await requestViaProxy({ proxyPort, method: variant.method, url }).catch(() => null);

    // Whichever upstream was addressed, it must NOT have received the credential.
    for (const up of [upstream, otherUpstream]) {
      if (up.last) expect(up.last.authorization).not.toBe(TEST_AUTH);
    }
    void active;
  });
});

// ---------------------------------------------------------------------------
// Redirect credential re-evaluation
// ---------------------------------------------------------------------------
describe('egress proxy redirect credential re-evaluation', () => {
  function secureGrant(port: number, key: string, pathPrefix = '/secure'): CredentialGrant {
    return {
      key, host: '127.0.0.1', port, scheme: 'http', methods: ['GET', 'POST'],
      pathPrefix, header: 'Authorization', prefix: 'Bearer ', highRisk: true,
    };
  }

  it('same-origin /secure/start -> /secure/final re-evaluates and may inject the credential on the second hop', async () => {
    const upstream = new RecordingUpstream((req, res) => {
      if (req.url === '/secure/start') {
        res.writeHead(302, { location: '/secure/final' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('final-ok');
    });
    const port = await upstream.listen();
    const proxy = trackProxy(new EgressProxy({
      policy: policyFor(['127.0.0.1'], [secureGrant(port, 'UPSTREAM_API_KEY')]),
      secrets: { UPSTREAM_API_KEY: TEST_SECRET },
      ca: SessionCa.create(),
      explicitTargets: [{ scheme: 'http', host: '127.0.0.1', port }],
    }));
    const proxyPort = await proxy.listen(0, '127.0.0.1');

    const r = await requestViaProxy({ proxyPort, url: `http://127.0.0.1:${port}/secure/start` });
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('final-ok');
    expect(upstream.count).toBe(2);
    // Second hop is same-origin within the grant prefix → credential re-injected.
    expect(upstream.last!.url).toBe('/secure/final');
    expect(upstream.last!.authorization).toBe(TEST_AUTH);
  });

  it('same-origin redirect outside the path prefix drops the credential on the second hop', async () => {
    const seen: Array<string | undefined> = [];
    const upstream = new RecordingUpstream((req, res) => {
      seen.push(req.headers.authorization);
      if (req.url === '/secure/start') {
        res.writeHead(302, { location: '/public/final' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('public-ok');
    });
    const port = await upstream.listen();
    const proxy = trackProxy(new EgressProxy({
      policy: policyFor(['127.0.0.1'], [secureGrant(port, 'UPSTREAM_API_KEY', '/secure')]),
      secrets: { UPSTREAM_API_KEY: TEST_SECRET },
      ca: SessionCa.create(),
      explicitTargets: [{ scheme: 'http', host: '127.0.0.1', port }],
    }));
    const proxyPort = await proxy.listen(0, '127.0.0.1');

    const r = await requestViaProxy({ proxyPort, url: `http://127.0.0.1:${port}/secure/start` });
    expect(r.status).toBe(200);
    expect(seen[0]).toBe(TEST_AUTH);           // first hop inside prefix → injected
    expect(seen[1]).not.toBe(TEST_AUTH);       // second hop outside prefix → absent
  });

  it('cross-origin redirect to another granted origin with NO credential grant proceeds without the credential', async () => {
    const originB = new RecordingUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('origin-b-ok');
    });
    const portB = await originB.listen();
    const originA = new RecordingUpstream((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${portB}/target` });
      res.end();
    });
    const portA = await originA.listen();

    const proxy = trackProxy(new EgressProxy({
      policy: policyFor(['127.0.0.1'], [secureGrant(portA, 'UPSTREAM_API_KEY', '/')]),
      secrets: { UPSTREAM_API_KEY: TEST_SECRET },
      ca: SessionCa.create(),
      explicitTargets: [
        { scheme: 'http', host: '127.0.0.1', port: portA },
        { scheme: 'http', host: '127.0.0.1', port: portB },
      ],
    }));
    const proxyPort = await proxy.listen(0, '127.0.0.1');

    const r = await requestViaProxy({
      proxyPort,
      url: `http://127.0.0.1:${portA}/start`,
      headers: { authorization: 'Bearer client-supplied' },
    });
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('origin-b-ok');
    expect(originA.last!.authorization).toBe(TEST_AUTH);   // origin A got its credential
    expect(originB.last!.authorization).not.toBe(TEST_AUTH); // stripped cross-origin
    expect(originB.last!.authorization).toBeUndefined();
  });

  it('cross-origin redirect to another granted origin with a DIFFERENT credential grant injects only the new credential', async () => {
    const OTHER_SECRET = 'other-secret-value';
    const originB = new RecordingUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('origin-b-ok');
    });
    const portB = await originB.listen();
    const originA = new RecordingUpstream((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${portB}/target` });
      res.end();
    });
    const portA = await originA.listen();

    const grantB: CredentialGrant = {
      key: 'ORIGIN_B_KEY', host: '127.0.0.1', port: portB, scheme: 'http',
      methods: ['GET'], pathPrefix: '/', header: 'Authorization', prefix: 'Bearer ', highRisk: true,
    };
    const proxy = trackProxy(new EgressProxy({
      policy: policyFor(['127.0.0.1'], [secureGrant(portA, 'ORIGIN_A_KEY', '/'), grantB]),
      secrets: { ORIGIN_A_KEY: TEST_SECRET, ORIGIN_B_KEY: OTHER_SECRET },
      ca: SessionCa.create(),
      explicitTargets: [
        { scheme: 'http', host: '127.0.0.1', port: portA },
        { scheme: 'http', host: '127.0.0.1', port: portB },
      ],
    }));
    const proxyPort = await proxy.listen(0, '127.0.0.1');

    const r = await requestViaProxy({ proxyPort, url: `http://127.0.0.1:${portA}/start` });
    expect(r.status).toBe(200);
    expect(originA.last!.authorization).toBe(TEST_AUTH);
    // Old credential stripped; ONLY origin B's credential present on hop 2.
    expect(originB.last!.authorization).toBe(`Bearer ${OTHER_SECRET}`);
    expect(originB.last!.authorization).not.toBe(TEST_AUTH);
    expect(originB.last!.authorizationHeaderCount).toBe(1);
  });

  it('cross-origin redirect to a denied origin returns 403 and makes no second upstream request', async () => {
    const originA = new RecordingUpstream((_req, res) => {
      res.writeHead(302, { location: 'http://denied.invalid/target' });
      res.end();
    });
    const portA = await originA.listen();
    const proxy = trackProxy(new EgressProxy({
      policy: policyFor(['127.0.0.1'], []),
      secrets: {},
      ca: SessionCa.create(),
      explicitTargets: [{ scheme: 'http', host: '127.0.0.1', port: portA }],
    }));
    const proxyPort = await proxy.listen(0, '127.0.0.1');

    const r = await requestViaProxy({ proxyPort, url: `http://127.0.0.1:${portA}/start` });
    expect(r.status).toBe(403);
    expect(originA.count).toBe(1); // only the first hop; denied origin never contacted
  });

  it('303 changes POST to GET and drops the body; 307/308 preserve method/body with each target re-evaluated', async () => {
    // --- 303: POST -> GET, body dropped ---
    const seen303: Array<{ method: string; bodyLen: number }> = [];
    const up303 = new RecordingUpstream((req, res) => {
      if (req.url === '/start') {
        res.writeHead(303, { location: '/final' });
        res.end();
        return;
      }
      let n = 0;
      req.on('data', c => { n += c.length; });
      req.on('end', () => {
        seen303.push({ method: req.method ?? '', bodyLen: n });
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok-303');
      });
    });
    const port303 = await up303.listen();
    const proxy303 = trackProxy(new EgressProxy({
      policy: policyFor(['127.0.0.1'], []),
      secrets: {},
      ca: SessionCa.create(),
      explicitTargets: [{ scheme: 'http', host: '127.0.0.1', port: port303 }],
    }));
    const pp303 = await proxy303.listen(0, '127.0.0.1');
    const r303 = await requestViaProxy({
      proxyPort: pp303, method: 'POST', url: `http://127.0.0.1:${port303}/start`, body: 'payload-303',
    });
    expect(r303.status).toBe(200);
    expect(seen303[0]).toEqual({ method: 'GET', bodyLen: 0 });

    // --- 307: POST preserved with body ---
    for (const code of [307, 308]) {
      const seen: Array<{ method: string; body: string }> = [];
      const up = new RecordingUpstream((req, res) => {
        if (req.url === '/start') {
          res.writeHead(code, { location: '/final' });
          res.end();
          return;
        }
        let b = '';
        req.on('data', c => { b += c; });
        req.on('end', () => {
          seen.push({ method: req.method ?? '', body: b });
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('ok-preserve');
        });
      });
      const port = await up.listen();
      const proxy = trackProxy(new EgressProxy({
        policy: policyFor(['127.0.0.1'], []),
        secrets: {},
        ca: SessionCa.create(),
        explicitTargets: [{ scheme: 'http', host: '127.0.0.1', port }],
      }));
      const pp = await proxy.listen(0, '127.0.0.1');
      const r = await requestViaProxy({
        proxyPort: pp, method: 'POST', url: `http://127.0.0.1:${port}/start`, body: 'payload-preserve',
      });
      expect(r.status).toBe(200);
      expect(seen[0]).toEqual({ method: 'POST', body: 'payload-preserve' });
    }
  });
});

// ---------------------------------------------------------------------------
// Response framing/cap + connection accounting
// ---------------------------------------------------------------------------
describe('egress proxy response framing/cap and connection accounting', () => {
  function makeCappedProxy(upstreamPort: number, extra: Record<string, unknown> = {}): EgressProxy {
    return trackProxy(new EgressProxy({
      policy: policyFor(['127.0.0.1']),
      secrets: {},
      ca: SessionCa.create(),
      explicitTargets: [{ scheme: 'http', host: '127.0.0.1', port: upstreamPort }],
      maxRespBytes: MAX_RESP_BYTES,
      ...extra,
    }));
  }

  it('returns a clean framed 502 when an upstream fixed-length response exceeds maxRespBytes', async () => {
    const bigBody = 'X'.repeat(MAX_RESP_BYTES * 4);
    const upstream = track(net.createServer((socket) => {
      socket.once('data', () => {
        socket.write([
          'HTTP/1.1 200 OK',
          'Content-Type: text/plain',
          `Content-Length: ${bigBody.length}`,
          '',
          bigBody,
        ].join('\r\n'));
        socket.end();
      });
    }));
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;

    const proxy = makeCappedProxy(upstreamPort);
    const proxyPort = await proxy.listen(0, '127.0.0.1');
    const r = await requestViaProxy({ proxyPort, url: `http://127.0.0.1:${upstreamPort}/oversized-content-length` });

    expect(r.status).toBe(502);
    expect(r.body.length).toBeLessThanOrEqual(MAX_RESP_BYTES);
    expect(r.headers['content-length']).toBe(String(r.body.length));
    expect(r.complete).toBe(true);
  });

  it('returns a clean framed 502 when an upstream chunked response exceeds maxRespBytes', async () => {
    const chunk = 'Y'.repeat(256);
    const upstream = track(net.createServer((socket) => {
      socket.once('data', () => {
        let out = 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n';
        // Emit enough chunks to exceed the cap.
        for (let i = 0; i < Math.ceil((MAX_RESP_BYTES * 4) / chunk.length); i++) {
          out += `${chunk.length.toString(16)}\r\n${chunk}\r\n`;
        }
        out += '0\r\n\r\n';
        socket.write(out);
        socket.end();
      });
    }));
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;

    const proxy = makeCappedProxy(upstreamPort);
    const proxyPort = await proxy.listen(0, '127.0.0.1');
    const r = await requestViaProxy({ proxyPort, url: `http://127.0.0.1:${upstreamPort}/oversized-chunked` });

    expect(r.status).toBe(502);
    expect(r.body.length).toBeLessThanOrEqual(MAX_RESP_BYTES);
    expect(r.headers['content-length']).toBe(String(r.body.length));
    // No upstream chunked framing leaks downstream.
    expect(r.rawResponse).not.toMatch(/transfer-encoding':\s*'chunked/i);
    expect(r.headers['transfer-encoding']).toBeUndefined();
  });

  it('enforces maxConns across HTTP keepalive and CONNECT and releases every slot once', async () => {
    // Granted upstream that responds 200 quickly.
    const upstream = new RecordingUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    const upstreamPort = await upstream.listen();

    const proxy = trackProxy(new EgressProxy({
      policy: policyFor(['127.0.0.1']),
      secrets: {},
      ca: SessionCa.create(),
      explicitTargets: [
        { scheme: 'http', host: '127.0.0.1', port: upstreamPort },
        // CONNECT targets are scheme https; grant the https explicit target so
        // the tunnel is established (and held) for the accounting assertion.
        { scheme: 'https', host: '127.0.0.1', port: upstreamPort },
      ],
      maxConns: 2,
      // Short pre-handshake idle window so the held CONNECT tunnel (which never
      // completes a TLS handshake) is reclaimed deterministically and quickly.
      connectHandshakeTimeoutMs: 300,
    }));
    const proxyPort = await proxy.listen(0, '127.0.0.1');

    // Hold one raw HTTP keepalive connection.
    const heldHttp = net.connect(proxyPort, '127.0.0.1');
    heldHttp.on('error', () => {});
    await new Promise<void>(r => heldHttp.once('connect', r));

    // Hold one CONNECT tunnel (TLS handshake intentionally never completed).
    const connectResult = await openConnect(proxyPort, `127.0.0.1:${upstreamPort}`);
    const heldConnect = connectResult.socket!;
    heldConnect.on('error', () => {});

    await new Promise(r => setTimeout(r, 100));
    expect(proxy.openConnectionCountForTest()).toBe(2);

    // Both slots held → a new granted request is refused with 503.
    const refused = await requestViaProxy({ proxyPort, url: `http://127.0.0.1:${upstreamPort}/` });
    expect(refused.status).toBe(503);

    // Release the HTTP keepalive slot → a new request now succeeds.
    heldHttp.destroy();
    await new Promise(r => setTimeout(r, 150));
    const allowed = await requestViaProxy({ proxyPort, url: `http://127.0.0.1:${upstreamPort}/` });
    expect(allowed.status).toBe(200);

    // The held CONNECT tunnel never completed its handshake; the pre-handshake
    // idle guard reclaims its slot once the (short) timeout elapses. Every slot
    // is then free — released exactly once, never negative.
    heldConnect.destroy();
    await new Promise(r => setTimeout(r, 700));
    expect(proxy.openConnectionCountForTest()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Raw-header smuggling (bytes via net.Socket; assert 400 before upstream)
// ---------------------------------------------------------------------------
describe('egress proxy raw-header smuggling', () => {
  it.each([
    [
      'Content-Length plus Transfer-Encoding',
      (port: number) => `GET http://127.0.0.1:${port}/ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n`,
    ],
    [
      'duplicate Host with differing values',
      (port: number) => `GET http://127.0.0.1:${port}/ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nHost: evil.example\r\n\r\n`,
    ],
    [
      'duplicate Host with identical values',
      (port: number) => `GET http://127.0.0.1:${port}/ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nHost: 127.0.0.1:${port}\r\n\r\n`,
    ],
    [
      'duplicate differing Content-Length',
      (port: number) => `GET http://127.0.0.1:${port}/ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 3\r\nContent-Length: 5\r\n\r\n`,
    ],
    [
      'comma-joined Transfer-Encoding chain whose final coding is not exactly one chunked',
      (port: number) => `GET http://127.0.0.1:${port}/ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nTransfer-Encoding: gzip, chunked\r\n\r\n`,
    ],
    [
      'obsolete line folding in a header',
      (port: number) => `GET http://127.0.0.1:${port}/ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n evil: x\r\n\r\n`,
    ],
    [
      'absolute-form authority different from Host',
      (port: number) => `GET http://127.0.0.1:${port}/ HTTP/1.1\r\nHost: attacker.example\r\n\r\n`,
    ],
  ])('returns 400 before any upstream request for %s', async (_name, build) => {
    const upstream = new RecordingUpstream();
    const upstreamPort = await upstream.listen();
    const proxy = trackProxy(new EgressProxy({
      policy: policyFor(['127.0.0.1']),
      secrets: {},
      ca: SessionCa.create(),
      explicitTargets: [{ scheme: 'http', host: '127.0.0.1', port: upstreamPort }],
    }));
    const proxyPort = await proxy.listen(0, '127.0.0.1');

    const r = await sendRawToProxy(proxyPort, build(upstreamPort));
    expect(r.status).toBe(400);
    expect(upstream.count).toBe(0);
  });

  it('returns 400 for a CONNECT authority different from the Host header', async () => {
    const upstream = new RecordingUpstream();
    const upstreamPort = await upstream.listen();
    const proxy = trackProxy(new EgressProxy({
      policy: policyFor(['127.0.0.1', 'granted.example']),
      secrets: {},
      ca: SessionCa.create(),
    }));
    const proxyPort = await proxy.listen(0, '127.0.0.1');
    void upstreamPort;

    // CONNECT authority is granted.example but Host names a third party.
    const r = await sendRawToProxy(
      proxyPort,
      `CONNECT granted.example:443 HTTP/1.1\r\nHost: attacker.example\r\n\r\n`,
    );
    expect(r.status).toBe(400);
  });

  it('returns 400 (or closes) for a header section above the configured cap', async () => {
    const upstream = new RecordingUpstream();
    const upstreamPort = await upstream.listen();
    const proxy = trackProxy(new EgressProxy({
      policy: policyFor(['127.0.0.1']),
      secrets: {},
      ca: SessionCa.create(),
      explicitTargets: [{ scheme: 'http', host: '127.0.0.1', port: upstreamPort }],
    }));
    const proxyPort = await proxy.listen(0, '127.0.0.1');

    // >16KB header section (proxy caps maxHeaderSize at 16KB).
    const huge = 'X'.repeat(20 * 1024);
    const r = await sendRawToProxy(
      proxyPort,
      `GET http://127.0.0.1:${upstreamPort}/ HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\nX-Pad: ${huge}\r\n\r\n`,
    );
    // Node's parser rejects oversized headers with 431 or a connection error;
    // the proxy must NOT forward to the upstream. Accept any non-2xx terminal.
    expect(r.status).not.toBe(200);
    expect(upstream.count).toBe(0);
  });

  it('returns 400 for an over-long request line', async () => {
    const upstream = new RecordingUpstream();
    const upstreamPort = await upstream.listen();
    const proxy = trackProxy(new EgressProxy({
      policy: policyFor(['127.0.0.1']),
      secrets: {},
      ca: SessionCa.create(),
      explicitTargets: [{ scheme: 'http', host: '127.0.0.1', port: upstreamPort }],
    }));
    const proxyPort = await proxy.listen(0, '127.0.0.1');

    const longPath = '/' + 'a'.repeat(20 * 1024);
    const r = await sendRawToProxy(
      proxyPort,
      `GET http://127.0.0.1:${upstreamPort}${longPath} HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\n\r\n`,
    );
    expect(r.status).not.toBe(200);
    expect(upstream.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DNS private-resolution and rebinding
// ---------------------------------------------------------------------------
describe('egress proxy DNS private-resolution and rebinding', () => {
  it('denies a granted hostname whose pinned answer is private, loopback, link-local, metadata, or multicast', async () => {
    const resolver = new FakeResolver();
    const proxy = trackProxy(new EgressProxy({
      policy: policyFor(['granted.example']),
      secrets: {},
      ca: SessionCa.create(),
      dnsLookup: resolver.lookup,
    }));
    const proxyPort = await proxy.listen(0, '127.0.0.1');

    for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', 'fe80::1', '224.0.0.1']) {
      resolver.set('granted.example', [ip]);
      const r = await requestViaProxy({ proxyPort, url: 'http://granted.example/' });
      expect(r.status).toBe(403);
    }
  });

  it('pins the validated answer for the socket and does not re-resolve to a private rebinding answer', async () => {
    const upstream = new RecordingUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('pinned-ok');
    });
    const upstreamPort = await upstream.listen();

    const resolver = new FakeResolver();
    resolver.sequence('granted.example', [['203.0.113.10'], ['127.0.0.1']]);

    // Connector: assert the proxy supplied the pinned public IP, then remap the
    // documentation-range IP to the local loopback fixture.
    const connectorState: { lastPinnedIp?: string } = {};
    const connector: UpstreamConnector = ({ pinnedIp, port }) => {
      connectorState.lastPinnedIp = pinnedIp;
      expect(pinnedIp).toBe('203.0.113.10');
      // The policy grants granted.example on port 80; the target port is 80,
      // but our fixture listens on upstreamPort — remap both address and port.
      void port;
      return net.connect(upstreamPort, '127.0.0.1');
    };

    const proxy = trackProxy(new EgressProxy({
      policy: policyFor(['granted.example']),
      secrets: {},
      ca: SessionCa.create(),
      dnsLookup: resolver.lookup,
      connector,
    }));
    const proxyPort = await proxy.listen(0, '127.0.0.1');

    const r = await requestViaProxy({ proxyPort, url: 'http://granted.example/' });
    expect(resolver.calls('granted.example')).toBe(1); // resolved once, never re-resolved
    expect(connectorState.lastPinnedIp).toBe('203.0.113.10');
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('pinned-ok');
  });
});

// ---------------------------------------------------------------------------
// TLS MITM
// ---------------------------------------------------------------------------
describe('egress proxy TLS MITM', () => {
  /**
   * Open a CONNECT tunnel through the proxy to the given TLS upstream, then
   * perform a client TLS handshake trusting the session CA, send one HTTP
   * request, and return the decoded body.
   */
  function httpsThroughConnect(opts: {
    proxyPort: number;
    upstreamPort: number;
    clientCa: string;
    path?: string;
  }): Promise<{ body: string; status: number }> {
    return new Promise((resolve, reject) => {
      const connectReq = http.request({
        host: '127.0.0.1',
        port: opts.proxyPort,
        method: 'CONNECT',
        path: `127.0.0.1:${opts.upstreamPort}`,
      });
      connectReq.on('connect', (_res, socket) => {
        const tlsSocket = tls.connect({
          socket: socket as net.Socket,
          ca: [opts.clientCa],
          rejectUnauthorized: true,
          // IP-literal SNI is unsupported; the leaf is validated by SAN instead.
          checkServerIdentity: () => undefined,
        }, () => {
          const req = `GET ${opts.path ?? '/'} HTTP/1.1\r\nHost: 127.0.0.1:${opts.upstreamPort}\r\nConnection: close\r\n\r\n`;
          tlsSocket.write(req);
          let response = '';
          tlsSocket.on('data', d => { response += d.toString('latin1'); });
          tlsSocket.on('end', () => {
            const sep = response.indexOf('\r\n\r\n');
            const head = sep >= 0 ? response.slice(0, sep) : response;
            const m = /^HTTP\/\d\.\d (\d+)/.exec(head);
            resolve({
              status: m ? Number(m[1]) : 0,
              body: sep >= 0 ? response.slice(sep + 4) : response,
            });
          });
          tlsSocket.on('error', reject);
        });
        tlsSocket.on('error', reject);
      });
      connectReq.on('error', reject);
      connectReq.end();
    });
  }

  it('MITMs CONNECT with an IP SAN type 7 leaf, trusts the session CA client-side, and validates the upstream against the injected test CA', async () => {
    // The session CA must mint an IP-literal leaf with SAN type 7.
    const sessionCa = SessionCa.create();
    const leafPem = sessionCa.issueForHost('127.0.0.1').certPem;
    const leaf = forge.pki.certificateFromPem(leafPem);
    const san = leaf.getExtension('subjectAltName') as { altNames: Array<{ type: number; ip?: string; value?: string }> };
    expect(san.altNames).toContainEqual(expect.objectContaining({ type: 7, ip: '127.0.0.1' }));

    // Real TLS upstream presenting the test-CA server leaf.
    const testCa = createTestUpstreamCa();
    const recorded: Array<string | undefined> = [];
    const tlsUpstream = track(https.createServer(
      { cert: testCa.serverCert, key: testCa.serverKey },
      (req, res) => {
        recorded.push(req.headers.authorization);
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('tls-ok');
      },
    ));
    await new Promise<void>(r => tlsUpstream.listen(0, '127.0.0.1', r));
    const tlsPort = (tlsUpstream.address() as net.AddressInfo).port;

    const grant: CredentialGrant = {
      key: 'UPSTREAM_API_KEY', host: '127.0.0.1', port: tlsPort, scheme: 'https',
      methods: ['GET'], pathPrefix: '/', header: 'Authorization', prefix: 'Bearer ', highRisk: true,
    };
    const proxy = trackProxy(new EgressProxy({
      policy: policyFor(['127.0.0.1'], [grant]),
      secrets: { UPSTREAM_API_KEY: TEST_SECRET },
      ca: sessionCa,
      explicitTargets: [{ scheme: 'https', host: '127.0.0.1', port: tlsPort }],
      upstreamTls: { ca: testCa.caCert },
    }));
    const proxyPort = await proxy.listen(0, '127.0.0.1');

    const response = await httpsThroughConnect({
      proxyPort, upstreamPort: tlsPort, clientCa: sessionCa.certPem,
    });
    expect(response.status).toBe(200);
    expect(response.body).toBe('tls-ok');
    expect(recorded[0]).toBe(TEST_AUTH);
  });

  it('rejects the same self-signed upstream when no test upstream CA is injected', async () => {
    const testCa = createTestUpstreamCa();
    const tlsUpstream = track(https.createServer(
      { cert: testCa.serverCert, key: testCa.serverKey },
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('should-not-reach');
      },
    ));
    await new Promise<void>(r => tlsUpstream.listen(0, '127.0.0.1', r));
    const tlsPort = (tlsUpstream.address() as net.AddressInfo).port;

    const sessionCa = SessionCa.create();
    const proxy = trackProxy(new EgressProxy({
      policy: policyFor(['127.0.0.1']),
      secrets: {},
      ca: sessionCa,
      explicitTargets: [{ scheme: 'https', host: '127.0.0.1', port: tlsPort }],
      // NO upstreamTls → production system trust must NOT accept the test CA.
    }));
    const proxyPort = await proxy.listen(0, '127.0.0.1');

    const response = await httpsThroughConnect({
      proxyPort, upstreamPort: tlsPort, clientCa: sessionCa.certPem,
    });
    expect(response.status).toBe(502);
  });
});
