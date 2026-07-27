import { describe, it, expect } from 'vitest';
import {
  EgressPolicyEngine,
  parseAbsoluteProxyTarget,
} from '../src/proxy/policy-engine.js';
import type { SandboxPolicy } from '../src/policy.js';

const policy: SandboxPolicy = {
  hosts: ['wttr.in', '*.example.com', '127.0.0.1'],
  credentials: [
    {
      key: 'WTR_API_KEY', host: 'wttr.in', port: 443, scheme: 'https',
      methods: ['GET'], pathPrefix: '/data', header: 'Authorization', prefix: 'Bearer ',
    },
    {
      key: 'WILD', host: '*.example.com', port: 443, scheme: 'https',
      methods: ['GET'], pathPrefix: '/v1', header: 'X-Key', highRisk: true,
    },
  ],
  resources: { memoryBytes: 512 * 1024 * 1024, timeoutMs: 30000, cpus: 0.5 },
  denied: { hosts: [], credentials: [] },
};

describe('parseAbsoluteProxyTarget', () => {
  it('accepts only absolute http/https URLs and normalizes the default port', () => {
    expect(parseAbsoluteProxyTarget('https://WTTR.IN/data?q=x', 'GET')).toEqual({
      scheme: 'https', host: 'wttr.in', port: 443, method: 'GET', path: '/data?q=x',
    });
    expect(() => parseAbsoluteProxyTarget('/origin-form', 'GET')).toThrow(/absolute-form/);
    expect(() => parseAbsoluteProxyTarget('ftp://wttr.in/file', 'GET')).toThrow(/unsupported scheme/);
  });

  it('rejects userinfo even when the host is granted', () => {
    expect(() => parseAbsoluteProxyTarget('https://user:pass@wttr.in/data', 'GET')).toThrow(/userinfo/);
  });
});

describe('EgressPolicyEngine.decide', () => {
  const eng = new EgressPolicyEngine(policy, {
    explicitTargets: [{ scheme: 'http', host: '127.0.0.1', port: 18080 }],
  });

  it('allows a granted host and attaches a fully matching credential', () => {
    const d = eng.decide({ scheme: 'https', host: 'wttr.in', port: 443, method: 'GET', path: '/data/x' });
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.credential?.key).toBe('WTR_API_KEY');
  });

  it('uses hostMatches for highRisk wildcard credential grants', () => {
    const d = eng.decide({ scheme: 'https', host: 'api.example.com', port: 443, method: 'GET', path: '/v1/x' });
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.credential?.key).toBe('WILD');
  });

  it('does not attach credentials outside path/method scope', () => {
    for (const target of [
      { scheme: 'https' as const, host: 'wttr.in', port: 443, method: 'POST', path: '/data/x' },
      { scheme: 'https' as const, host: 'wttr.in', port: 443, method: 'GET', path: '/other' },
    ]) {
      const d = eng.decide(target);
      expect(d.allow).toBe(true);
      if (d.allow) expect(d.credential).toBeUndefined();
    }
  });

  it('denies ungranted hosts, wildcard apex, and ungranted non-standard ports', () => {
    expect(eng.decide({ scheme: 'https', host: 'evil.com', port: 443, method: 'GET', path: '/' }).allow).toBe(false);
    expect(eng.decide({ scheme: 'https', host: 'example.com', port: 443, method: 'GET', path: '/' }).allow).toBe(false);
    expect(eng.decide({ scheme: 'http', host: '127.0.0.1', port: 18081, method: 'GET', path: '/' }).allow).toBe(false);
  });

  it('allows an exact trusted non-standard port grant', () => {
    expect(eng.decide({ scheme: 'http', host: '127.0.0.1', port: 18080, method: 'GET', path: '/' }).allow).toBe(true);
  });

  it('allows an explicitly granted private literal but denies an ungranted one', () => {
    const allowed = eng.decide({ scheme: 'http', host: '127.0.0.1', port: 18080, method: 'GET', path: '/' });
    expect(allowed).toEqual(expect.objectContaining({ allow: true, allowPrivateLiteral: true }));
    expect(eng.decide({ scheme: 'http', host: '10.0.0.5', port: 80, method: 'GET', path: '/' }).allow).toBe(false);
  });

  it('classifies IPv4 and IPv6 SSRF ranges', () => {
    expect(eng.isPrivateOrLinkLocal('127.0.0.1')).toBe(true);
    expect(eng.isPrivateOrLinkLocal('169.254.1.1')).toBe(true);
    expect(eng.isPrivateOrLinkLocal('10.0.0.5')).toBe(true);
    expect(eng.isPrivateOrLinkLocal('100.64.0.1')).toBe(true);
    expect(eng.isPrivateOrLinkLocal('::1')).toBe(true);
    expect(eng.isPrivateOrLinkLocal('fe80::1')).toBe(true);
    expect(eng.isPrivateOrLinkLocal('8.8.8.8')).toBe(false);
  });
});
