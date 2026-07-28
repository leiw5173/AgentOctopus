import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {
  EgressPolicyEngine,
  parseAbsoluteProxyTarget,
  type ExplicitTargetGrant,
  type ProxyTarget,
} from './policy-engine.js';
import {
  sanitizeRequestHeaders,
  sanitizeResponseHeaders,
  injectCredential,
  SmugglingError,
} from './headers.js';
import { resolveAndPin, ForbiddenAddressError, type DnsLookup } from './dns.js';
import type { SessionCa } from './ca.js';
import type { SandboxPolicy } from '../policy.js';

export interface ResolvedSecrets { [grantKey: string]: string }

export interface UpstreamTlsOptions {
  ca?: string | Buffer | Array<string | Buffer>;
  agent?: https.Agent;
}

/**
 * Test-only connector override (spec §9 Task 4). When supplied, the proxy calls
 * this to originate the upstream socket instead of the default
 * `net.connect`/`tls.connect`. The proxy ALWAYS passes the validated, pinned IP
 * it is about to dial; the connector may remap that address (e.g. a doc-range
 * IP → a loopback fixture) but the proxy itself never re-resolves. Production
 * omits this and dials the pinned IP directly.
 */
export type UpstreamConnector = (args: {
  pinnedIp: string;
  port: number;
  isHttps: boolean;
  servername?: string;
  ca?: string | Buffer | Array<string | Buffer>;
}) => net.Socket | tls.TLSSocket;

export interface EgressProxyOptions {
  policy: SandboxPolicy;
  secrets: ResolvedSecrets;
  ca: SessionCa;
  explicitTargets?: ExplicitTargetGrant[];
  dnsLookup?: DnsLookup;
  upstreamTls?: UpstreamTlsOptions;
  connector?: UpstreamConnector;
  maxReqBytes?: number;
  maxRespBytes?: number;
  maxConns?: number;
  /**
   * Idle window (ms) granted to a CONNECT tunnel to complete its TLS handshake
   * before the slot is reclaimed. Defaults to CONNECT_HANDSHAKE_TIMEOUT_MS.
   * Tests override this to a small value to exercise the reclaim path quickly.
   */
  connectHandshakeTimeoutMs?: number;
}

// Header size cap enforced on the server in listen() (review M10 — actually
// applied, not just declared). No separate header-COUNT constant: Node caps
// that via maxHeaderSize / --max-http-header-size.
const HEADER_BYTES_CAP = 16 * 1024;
const MAX_REDIRECTS = 10;
const UPSTREAM_ERROR_BODY = 'upstream error';
// Idle window granted to a CONNECT tunnel to complete its TLS handshake before
// the slot is reclaimed. Generous enough for a real client, short enough to
// bound a resource-exhaustion attempt that opens tunnels and stalls.
const CONNECT_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Validate the raw Transfer-Encoding chain (spec §9). The only legal chain is
 * exactly one terminal `chunked` coding — no comma-joined stack, no split
 * headers, and no non-identity coding before/after it. Operating on
 * `rawHeaders` (not Node's normalized `req.headers`) so a comma-joined value
 * such as `gzip, chunked` that the parser tolerates is still rejected here.
 * Throws SmugglingError on any deviation.
 */
export function assertTransferEncodingChain(rawHeaders: readonly string[]): void {
  const codings: string[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() !== 'transfer-encoding') continue;
    const value = rawHeaders[i + 1] ?? '';
    for (const part of value.split(',')) codings.push(part.trim().toLowerCase());
  }
  if (codings.length === 0) return; // no TE header — fine
  if (codings.length !== 1 || codings[0] !== 'chunked') {
    throw new SmugglingError(`unsupported Transfer-Encoding chain: ${codings.join(', ')}`);
  }
}

/**
 * Trusted egress proxy (spec §9): the only network path out of the sandbox.
 * One instance per execution. Terminates HTTP and (MITM) HTTPS, enforces
 * policy per request, injects grant-scoped credentials, and originates its own
 * upstream sockets.
 */
export class EgressProxy {
  private readonly engine: EgressPolicyEngine;
  private server?: http.Server;
  private port = 0;
  private openConns = 0;
  private readonly liveSockets = new Set<net.Socket>();

  get activeConnections(): number { return this.openConns; }

  /**
   * Test-only snapshot of currently open downstream connections. Alias of
   * `activeConnections` so the security lane can assert connection accounting
   * returns to zero after every slot is released exactly once.
   */
  openConnectionCountForTest(): number { return this.openConns; }

  private trackSocket(socket: net.Socket): void {
    if (this.openConns >= (this.opts.maxConns ?? 32)) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    this.openConns++;
    this.liveSockets.add(socket);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.liveSockets.delete(socket);
      this.openConns = Math.max(0, this.openConns - 1);
    };
    socket.once('close', release);
    socket.once('error', release);
  }

  constructor(private readonly opts: EgressProxyOptions) {
    this.engine = new EgressPolicyEngine(opts.policy, { explicitTargets: opts.explicitTargets });
  }

  address(host = '127.0.0.1'): string { return `http://${host}:${this.port}`; }

  async listen(port = 0, host = '127.0.0.1'): Promise<number> {
    this.server = http.createServer(
      { maxHeaderSize: HEADER_BYTES_CAP },
      (req, res) => this.handleHttp(req, res),
    );
    this.server.on('connection', (socket) => this.trackSocket(socket));
    this.server.on('connect', (req, socket, head) => this.handleConnect(req, socket as net.Socket, head));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => resolve());
    });
    this.port = (this.server.address() as net.AddressInfo).port;
    return this.port;
  }

  async close(): Promise<void> {
    this.opts.ca.destroy();
    // Destroy every live downstream socket (including CONNECT tunnels handed to
    // the internal MITM https.Server) so server.close() is not held open by an
    // idle keepalive or tunnelled connection. Each destroy fires that socket's
    // 'close' → its slot is released exactly once.
    for (const socket of this.liveSockets) socket.destroy();
    if (!this.server) return;
    const s = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private secretFor(grantKey: string): string | undefined {
    return this.opts.secrets[grantKey];
  }

  private async forward(
    target: ProxyTarget,
    reqHeaders: Record<string, string | string[]>,
    body: Buffer,
    res: http.ServerResponse,
    redirects = 0,
  ): Promise<void> {
    try {
      const decision = this.engine.decide(target);
      if (!decision.allow) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end(`egress denied: ${decision.reason}`);
        return;
      }

      let headers = reqHeaders;
      if (decision.credential) {
        const secret = this.secretFor(decision.credential.key);
        if (secret) headers = injectCredential(headers, decision.credential, secret);
      }

      // We buffered the body, so replace request framing with its exact length.
      const fwdHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(headers)) {
        const lk = k.toLowerCase();
        if (lk === 'content-length' || lk === 'transfer-encoding') continue;
        fwdHeaders[lk] = v;
      }
      fwdHeaders['content-length'] = String(body.length);

      let pinnedIp: string;
      try {
        pinnedIp = await resolveAndPin(target.host, {
          lookup: this.opts.dnsLookup,
          isForbiddenAddress: (address) => this.engine.isPrivateOrLinkLocal(address),
          allowPrivateLiteral: decision.allowPrivateLiteral,
        });
      } catch (err) {
        // A forbidden DNS answer / private literal is a policy denial (403),
        // distinct from a genuine DNS resolution failure (502 handled by the
        // outer catch). Return early so the 502 branch is never reached for it.
        if (err instanceof ForbiddenAddressError) {
          if (!res.headersSent) {
            res.writeHead(403, { 'content-type': 'text/plain' });
            res.end(`egress denied: ${err.message}`);
          }
          return;
        }
        throw err; // genuine DNS failure → outer catch sends 502
      }

      // The request connects to pinnedIp. `servername` and Host remain the logical
      // target so TLS identity and HTTP authority are checked consistently.
      // Node.js rejects servername set to an IP address, so only set it for
      // actual hostnames; for IP literals the upstream cert is verified by SAN.
      const isHttps = target.scheme === 'https';
      const client = isHttps ? https : http;
      const hostHeaderValue = target.port === (isHttps ? 443 : 80)
        ? target.host
        : `${target.host}:${target.port}`;
      const servername = isHttps && net.isIP(target.host) === 0 ? target.host : undefined;
      const upstreamCa = isHttps ? this.opts.upstreamTls?.ca : undefined;

      // Test-only connector override: originate the socket through the injected
      // connector (which may remap the pinned IP to a local fixture). The proxy
      // always supplies the validated pinnedIp — it never re-resolves here.
      const createConnection = this.opts.connector
        ? () => this.opts.connector!({ pinnedIp, port: target.port, isHttps, servername, ca: upstreamCa })
        : undefined;

      const upstreamReq = client.request({
        host: pinnedIp,
        servername,
        port: target.port,
        method: target.method,
        path: target.path,
        headers: {
          ...fwdHeaders,
          host: hostHeaderValue,
        },
        rejectUnauthorized: true,
        ca: upstreamCa,
        agent: isHttps ? this.opts.upstreamTls?.agent : undefined,
        createConnection,
      } as https.RequestOptions, (upstreamRes) => {
        void this.relayOrRedirect({ target, reqHeaders, body, res, upstreamRes, redirects });
      });

      upstreamReq.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain', 'content-length': String(UPSTREAM_ERROR_BODY.length) });
        }
        res.end(UPSTREAM_ERROR_BODY);
      });
      upstreamReq.end(body);
    } catch {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain', 'content-length': String(UPSTREAM_ERROR_BODY.length) });
      }
      res.end(UPSTREAM_ERROR_BODY);
    }
  }

  private originOf(target: ProxyTarget): string {
    const defaultPort = target.scheme === 'https' ? 443 : 80;
    const authority = target.port === defaultPort ? target.host : `${target.host}:${target.port}`;
    return `${target.scheme}://${authority}`;
  }

  private async relayOrRedirect(args: {
    target: ProxyTarget;
    reqHeaders: Record<string, string | string[]>;
    body: Buffer;
    res: http.ServerResponse;
    upstreamRes: http.IncomingMessage;
    redirects: number;
  }): Promise<void> {
    const { target, reqHeaders, body, res, upstreamRes, redirects } = args;
    try {
      const status = upstreamRes.statusCode ?? 502;
      const location = upstreamRes.headers.location;

      if ([301, 302, 303, 307, 308].includes(status) && location) {
        upstreamRes.resume();
        // A reset on the drained hop-N response must not throw uncaught.
        upstreamRes.on('error', () => {});
        if (redirects >= MAX_REDIRECTS) {
          res.writeHead(502, { 'content-type': 'text/plain' });
          res.end('too many redirects');
          return;
        }

        let next: ProxyTarget;
        try {
          const absolute = new URL(location, `${this.originOf(target)}${target.path}`).toString();
          next = parseAbsoluteProxyTarget(absolute, target.method);
        } catch {
          res.writeHead(502, { 'content-type': 'text/plain' });
          res.end('bad redirect location');
          return;
        }

        const originChanged = this.originOf(next) !== this.originOf(target);
        const cleanHeaders = { ...reqHeaders };
        if (originChanged) {
          // Strip all managed credential headers on cross-origin redirect
          for (const grant of this.opts.policy.credentials) {
            delete cleanHeaders[grant.header.toLowerCase()];
          }
        }

        const switchToGet = status === 303 || ((status === 301 || status === 302) && target.method === 'POST');
        if (switchToGet) {
          next.method = 'GET';
          await this.forward(next, cleanHeaders, Buffer.alloc(0), res, redirects + 1);
        } else {
          await this.forward(next, cleanHeaders, body, res, redirects + 1);
        }
        return;
      }

      // Buffer the complete response before forwarding any bytes to the client
      const cap = this.opts.maxRespBytes ?? 10_485_760;
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of upstreamRes) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > cap) {
          upstreamRes.destroy();
          const msg = Buffer.from('response too large');
          res.writeHead(502, { 'content-type': 'text/plain', 'content-length': String(msg.length) });
          res.end(msg);
          return;
        }
        chunks.push(Buffer.from(chunk));
      }

      const responseBody = Buffer.concat(chunks);
      res.writeHead(status, sanitizeResponseHeaders(upstreamRes.headers, responseBody.length));
      res.end(responseBody);
    } catch {
      // Response-phase upstream failure (ECONNRESET mid-body, etc.) — clean 502.
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain', 'content-length': String(UPSTREAM_ERROR_BODY.length) });
      }
      res.end(UPSTREAM_ERROR_BODY);
    }
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    let target: ProxyTarget;
    try {
      target = parseAbsoluteProxyTarget(req.url ?? '', req.method ?? 'GET');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad absolute-form request target');
      return;
    }

    let headers: Record<string, string | string[]>;
    try {
      headers = sanitizeRequestHeaders(req.headers, req.rawHeaders);
      assertTransferEncodingChain(req.rawHeaders);
      // Desync guard: in a forward proxy the client legitimately sets Host to
      // the PROXY's own address while the request line carries the absolute-form
      // target. The proxy always forwards an authority derived from the parsed
      // request-line target (never the client Host), so it is internally
      // consistent. We only reject when the client supplies a Host header that
      // names a *third* authority — neither the proxy nor the request-line
      // target — which is the ambiguous smuggling shape.
      const hostHeader = headers.host === undefined ? undefined : String(headers.host).toLowerCase();
      if (hostHeader !== undefined) {
        const defaultPort = target.scheme === 'https' ? 443 : 80;
        const targetAuthority = (target.port === defaultPort ? target.host : `${target.host}:${target.port}`).toLowerCase();
        const proxyAuthority = this.address().replace(/^https?:\/\//, '').toLowerCase();
        const proxyHost = proxyAuthority.split(':')[0]!;
        if (
          hostHeader !== targetAuthority &&
          hostHeader !== target.host.toLowerCase() &&
          hostHeader !== proxyAuthority &&
          hostHeader !== proxyHost
        ) {
          throw new SmugglingError('absolute-form authority disagrees with Host header');
        }
      }
    } catch (err) {
      if (err instanceof SmugglingError) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end(`smuggling rejected: ${err.message}`);
        return;
      }
      throw err;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    const cap = this.opts.maxReqBytes ?? 1_048_576;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > cap) {
        res.writeHead(413, { 'content-type': 'text/plain' });
        res.end('request too large');
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => this.forward(target, headers, Buffer.concat(chunks), res));
    req.on('error', () => { res.end(); });
  }

  private handleConnect(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    let host = '';
    let port = 443;
    try {
      const authority = new URL(`https://${req.url ?? ''}`);
      if (authority.username || authority.password || authority.pathname !== '/') throw new Error('bad CONNECT authority');
      host = authority.hostname;
      port = authority.port ? Number(authority.port) : 443;
    } catch {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    const target: ProxyTarget = { scheme: 'https', host, port, method: 'GET', path: '/' };

    // Desync guard: a CONNECT client legitimately sets Host to the PROXY's own
    // address while the request line carries the CONNECT authority. The proxy
    // always uses the request-line authority, so it is internally consistent.
    // Reject only when Host names a *third* authority — neither the CONNECT
    // authority nor the proxy — which is the ambiguous smuggling shape.
    const rawHost = req.headers.host;
    if (rawHost !== undefined) {
      const connectAuthority = (port === 443 ? host : `${host}:${port}`).toLowerCase();
      const proxyAuthority = this.address().replace(/^https?:\/\//, '').toLowerCase();
      const proxyHost = proxyAuthority.split(':')[0]!;
      const normalizedRaw = rawHost.toLowerCase();
      if (
        normalizedRaw !== connectAuthority &&
        normalizedRaw !== host.toLowerCase() &&
        normalizedRaw !== proxyAuthority &&
        normalizedRaw !== proxyHost
      ) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }
    }

    const decision = this.engine.decide(target);
    if (!decision.allow) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) socket.unshift(head);

    // MITM: mint a per-host cert, then let an https.Server perform the TLS
    // handshake on the RAW client socket (review B8). Do NOT pre-wrap the
    // socket in a TLSSocket or emit a hand-built TLSSocket — pass the raw
    // socket to 'connection' and the server upgrades it and emits
    // 'secureConnection' itself.
    const leaf = this.opts.ca.issueForHost(host);
    const secureContext = tls.createSecureContext({ cert: leaf.certPem, key: leaf.keyPem });

    const httpsServer = new https.Server({
      maxHeaderSize: HEADER_BYTES_CAP,
      cert: leaf.certPem,
      key: leaf.keyPem,
      // The leaf is minted for the CONNECT authority `host`. If the client sends
      // an SNI that differs, do NOT silently serve the authority-host leaf —
      // re-check policy for the SNI hostname and re-mint only if it is granted;
      // otherwise fail the handshake so SNI-based identity is enforced.
      SNICallback: (servername, cb) => {
        if (servername && servername.toLowerCase() !== host.toLowerCase()) {
          const sniTarget: ProxyTarget = { scheme: 'https', host: servername, port, method: 'GET', path: '/' };
          const sniDecision = this.engine.decide(sniTarget);
          if (!sniDecision.allow) {
            cb(new Error(`SNI ${servername} not granted`), undefined);
            return;
          }
          const sniLeaf = this.opts.ca.issueForHost(servername);
          cb(null, tls.createSecureContext({ cert: sniLeaf.certPem, key: sniLeaf.keyPem }));
          return;
        }
        cb(null, secureContext);
      },
    });

    httpsServer.on('secureConnection', () => {
      // Handshake complete — cancel the pre-handshake idle guard.
      socket.setTimeout(0);
    });
    httpsServer.on('request', (innerReq, innerRes) => {
      const innerTarget: ProxyTarget = {
        scheme: 'https',
        host,
        port,
        method: innerReq.method ?? 'GET',
        path: innerReq.url ?? '/',
      };
      this.handleInnerHttps(innerTarget, innerReq, innerRes);
    });
    httpsServer.on('tlsClientError', () => socket.destroy());

    // Pre-handshake idle guard: a CONNECT client that never completes the TLS
    // handshake (or disconnects abruptly, whose FIN/RST the kernel may not
    // surface promptly on an unread socket) would otherwise pin a connection
    // slot forever and exhaust maxConns. Bound the handshake window; on expiry
    // destroy the socket so trackSocket's release runs exactly once.
    socket.setTimeout(this.opts.connectHandshakeTimeoutMs ?? CONNECT_HANDSHAKE_TIMEOUT_MS, () => socket.destroy());

    // Hand the RAW socket to the server; it wraps + handshakes internally.
    httpsServer.emit('connection', socket);
  }

  private handleInnerHttps(target: ProxyTarget, req: http.IncomingMessage, res: http.ServerResponse): void {
    let headers: Record<string, string | string[]>;
    try {
      headers = sanitizeRequestHeaders(req.headers, req.rawHeaders);
      assertTransferEncodingChain(req.rawHeaders);
      const expectedAuthority = target.port === 443 ? target.host : `${target.host}:${target.port}`;
      if (headers.host !== expectedAuthority) throw new SmugglingError('inner Host disagrees with CONNECT authority');
    } catch (err) {
      if (err instanceof SmugglingError) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('smuggling rejected');
        return;
      }
      throw err;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    const cap = this.opts.maxReqBytes ?? 1_048_576;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > cap) {
        res.writeHead(413, { 'content-type': 'text/plain' });
        res.end('request too large');
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => this.forward(target, headers, Buffer.concat(chunks), res));
    req.on('error', () => res.end());
  }
}
