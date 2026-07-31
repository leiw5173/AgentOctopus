import { describe, it, expect } from 'vitest';
import {
  normalizeHost, hostMatches, isPublicSuffixWildcard, normalizePath, pathMatchesPrefix,
  stripIpv6Brackets,
} from '../src/host-match.js';

describe('host matching', () => {
  it('exact host matches only itself, not subdomains', () => {
    expect(hostMatches('api.example.com', 'api.example.com')).toBe(true);
    expect(hostMatches('api.example.com', 'x.api.example.com')).toBe(false);
    expect(hostMatches('example.com', 'www.example.com')).toBe(false);
  });
  it('wildcard matches subdomains but not apex', () => {
    expect(hostMatches('*.example.com', 'a.example.com')).toBe(true);
    expect(hostMatches('*.example.com', 'example.com')).toBe(false);
  });
  it('rejects public-suffix wildcards, including multi-label and private suffixes', () => {
    expect(isPublicSuffixWildcard('*.com')).toBe(true);
    expect(isPublicSuffixWildcard('*.co.uk')).toBe(true);
    expect(isPublicSuffixWildcard('*.github.io')).toBe(true);
    expect(isPublicSuffixWildcard('*.example.com')).toBe(false);
    expect(hostMatches('*.com', 'anything.com')).toBe(false);
    expect(hostMatches('*.co.uk', 'shop.co.uk')).toBe(false);
  });
  it('normalizes case and trailing dot', () => {
    expect(normalizeHost('WTTR.IN.')).toBe('wttr.in');
    expect(hostMatches('wttr.in', 'WTTR.IN.')).toBe(true);
  });
  // F6: Node's URL.hostname preserves IPv6 brackets, so normalizeHost must
  // strip them — otherwise the explicitly-allowed `::1` is rejected by every
  // caller (vm-backend loopback check, policy-engine target normalization).
  it('strips IPv6 brackets from a bracketed hostname (F6)', () => {
    expect(stripIpv6Brackets('[::1]')).toBe('::1');
    expect(stripIpv6Brackets('[fe80::1]')).toBe('fe80::1');
    // idempotent / pass-through for non-IPv6 and already-bare hosts
    expect(stripIpv6Brackets('127.0.0.1')).toBe('127.0.0.1');
    expect(stripIpv6Brackets('::1')).toBe('::1');
    expect(stripIpv6Brackets('localhost')).toBe('localhost');
  });
  it('normalizeHost strips IPv6 brackets so ::1 is a valid loopback target (F6)', () => {
    expect(normalizeHost('[::1]')).toBe('::1');
    expect(normalizeHost('[FE80::1]')).toBe('fe80::1');
    expect(normalizeHost('::1')).toBe('::1');
  });
});

describe('path normalization', () => {
  it('resolves dot segments and duplicate slashes', () => {
    expect(normalizePath('/a/./b/../c')).toBe('/a/c');
    expect(normalizePath('/a//b')).toBe('/a/b');
  });
  it('decodes percent-encoding to defeat prefix bypass', () => {
    expect(pathMatchesPrefix('/data', '/data/x')).toBe(true);
    expect(pathMatchesPrefix('/data', '/%2e%2e/secret')).toBe(false);
  });
});
