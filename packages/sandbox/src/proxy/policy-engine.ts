import net from 'node:net';
import { hostMatches, pathMatchesPrefix, normalizeHost } from '../host-match.js';
import type { SandboxPolicy } from '../policy.js';
import type { CredentialGrant } from '../schema.js';

export class PolicyError extends Error {
  override name = 'PolicyError' as const;
}

export interface ProxyTarget {
  scheme: 'http' | 'https';
  host: string;
  port: number;
  method: string;
  path: string;
}

export interface ExplicitTargetGrant {
  scheme: 'http' | 'https';
  host: string;
  port: number;
}

export type PolicyDecision =
  | { allow: true; credential?: CredentialGrant; allowPrivateLiteral: boolean }
  | { allow: false; reason: string };

const DEFAULT_PORT: Record<'http' | 'https', number> = { http: 80, https: 443 };

export function parseAbsoluteProxyTarget(rawUrl: string, method: string): ProxyTarget {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PolicyError('absolute-form http(s) request target required');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PolicyError('unsupported scheme');
  }
  if (url.username || url.password) {
    throw new PolicyError('userinfo is forbidden');
  }
  if (!url.hostname) {
    throw new PolicyError('empty host');
  }
  const scheme = url.protocol.slice(0, -1) as 'http' | 'https';
  return {
    scheme,
    host: normalizeHost(url.hostname),
    port: url.port ? Number(url.port) : DEFAULT_PORT[scheme],
    method: method.toUpperCase(),
    path: `${url.pathname}${url.search}`,
  };
}

function isIPv4Literal(host: string): boolean {
  return net.isIP(host) === 4;
}

function parseIPv4(addr: string): number[] {
  return addr.split('.').map(Number);
}

function parseIPv6(addr: string): number[] {
  let s = addr;
  // Strip zone ID (e.g. fe80::1%eth0 → fe80::1)
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct);

  const dc = s.indexOf('::');
  let halves: string[];
  if (dc !== -1) {
    const left = dc > 0 ? s.slice(0, dc).split(':') : [];
    const right = dc + 2 < s.length ? s.slice(dc + 2).split(':') : [];
    const fill = 8 - left.length - right.length;
    halves = [...left, ...Array(fill).fill('0'), ...right];
  } else {
    halves = s.split(':');
  }
  return halves.map(h => parseInt(h || '0', 16));
}

/**
 * Classify IPv4 and IPv6 SSRF-relevant ranges by parsed byte/group values
 * (not string prefixes).
 */
function isPrivateOrLinkLocalAddr(addr: string): boolean {
  const v = net.isIP(addr);
  if (v === 4) {
    const [a, b] = parseIPv4(addr);
    // 0.0.0.0/8 — "this" network
    if (a === 0) return true;
    // 10.0.0.0/8
    if (a === 10) return true;
    // 100.64.0.0/10 — carrier-grade NAT
    if (a === 100 && b >= 64 && b <= 127) return true;
    // 127.0.0.0/8 — loopback
    if (a === 127) return true;
    // 169.254.0.0/16 — link-local
    if (a === 169 && b === 254) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 224.0.0.0/4 — multicast
    if (a >= 224 && a <= 239) return true;
    // 240.0.0.0/4 — reserved (includes 255.255.255.255)
    if (a >= 240) return true;
    return false;
  }
  if (v === 6) {
    const g = parseIPv6(addr);
    // Unspecified ::
    if (g.every(x => x === 0)) return true;
    // Loopback ::1
    if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return true;
    // ULA fc00::/7 — first byte high 7 bits = 1111110 → 0xfc or 0xfd
    if ((g[0] & 0xfe00) === 0xfc00) return true;
    // Link-local fe80::/10 — first byte high 10 bits = 1111111010 → 0xfe80–0xfebf
    if ((g[0] & 0xffc0) === 0xfe80) return true;
    // IPv4-mapped ::ffff:x.x.x.x
    if (
      g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 &&
      g[4] === 0 && g[5] === 0xffff
    ) {
      const lo16 = g[7];
      const hi16 = g[6];
      const ip4a = (hi16 >> 8) & 0xff;
      const ip4b = hi16 & 0xff;
      const ip4c = (lo16 >> 8) & 0xff;
      const ip4d = lo16 & 0xff;
      return isPrivateOrLinkLocalAddr(`${ip4a}.${ip4b}.${ip4c}.${ip4d}`);
    }
    return false;
  }
  return false;
}

export class EgressPolicyEngine {
  private policy: SandboxPolicy;
  private explicitTargets: ExplicitTargetGrant[];

  constructor(policy: SandboxPolicy, opts?: { explicitTargets?: ExplicitTargetGrant[] }) {
    this.policy = policy;
    this.explicitTargets = opts?.explicitTargets ?? [];
  }

  decide(target: ProxyTarget): PolicyDecision {
    const { scheme, port, method, path } = target;
    const host = normalizeHost(target.host);

    // Rule 1: reject invalid scheme or port
    if (scheme !== 'http' && scheme !== 'https') {
      return { allow: false, reason: 'unsupported scheme' };
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { allow: false, reason: 'invalid port' };
    }

    // Rule 2: require a host grant (wildcards never authorize IP literals)
    const hostGranted = this.policy.hosts.some(pattern => hostMatches(pattern, host));
    if (!hostGranted) {
      return { allow: false, reason: 'host not granted' };
    }

    // Rule 3: default port is always permitted; non-default requires an exact
    // ExplicitTargetGrant or credential grant naming the same scheme+host+port.
    const defaultPort = DEFAULT_PORT[scheme];
    if (port !== defaultPort) {
      const hasExplicit = this.explicitTargets.some(
        t => normalizeHost(t.host) === host && t.scheme === scheme && t.port === port,
      );
      const hasCredPort = this.policy.credentials.some(
        c => c.scheme === scheme && c.port === port && hostMatches(c.host, host),
      );
      if (!hasExplicit && !hasCredPort) {
        return { allow: false, reason: `port ${port} not granted for ${scheme}` };
      }
    }

    // Rule 4: allowPrivateLiteral — exact literal grant of a private/loopback IP
    let allowPrivateLiteral = false;
    if (net.isIP(host) !== 0) {
      const isPrivate = isPrivateOrLinkLocalAddr(host);
      const exactLiteralGranted = this.policy.hosts.some(
        p => !p.includes('*') && normalizeHost(p) === host,
      );
      if (isPrivate && exactLiteralGranted) {
        allowPrivateLiteral = true;
      }
    }

    // Rule 5: find a credential matching scheme+port+method+path; wildcard-host
    // or root-pathPrefix credentials require highRisk === true.
    const upperMethod = method.toUpperCase();
    let credential: CredentialGrant | undefined;
    for (const c of this.policy.credentials) {
      if (c.scheme !== scheme) continue;
      if (c.port !== port) continue;
      if (!hostMatches(c.host, host)) continue;
      if (!c.methods.some(m => m.toUpperCase() === upperMethod)) continue;
      if (!pathMatchesPrefix(c.pathPrefix, path)) continue;
      // Wildcard-host credential: requires highRisk
      if (c.host.includes('*') && !c.highRisk) continue;
      // Root-pathPrefix credential: requires highRisk
      if (c.pathPrefix === '/' && !c.highRisk) continue;
      credential = c;
      break;
    }

    // Rule 6: allow — attach credential if one was found
    return { allow: true, credential, allowPrivateLiteral };
  }

  isPrivateOrLinkLocal(address: string): boolean {
    return isPrivateOrLinkLocalAddr(address);
  }
}
