import { describe, it, expect } from 'vitest';
import {
  normalizeHost, hostMatches, isPublicSuffixWildcard, normalizePath, pathMatchesPrefix,
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
