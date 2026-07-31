import { domainToASCII } from 'node:url';
import { getDomain, getPublicSuffix } from 'tldts';

/**
 * Host + path matching for egress policy (spec §8/§9). Exact by default;
 * `*.example.com` authorizes subdomains only (not apex); public-suffix
 * wildcards are rejected.
 */

/**
 * Strip the square brackets Node's URL leaves on an IPv6 hostname.
 * `new URL('http://[::1]:8080').hostname` returns `"[::1]"` (WITH brackets)
 * on every supported Node version — the WHATWG URL spec preserves them on
 * `.hostname`. normalizeHost and the loopback check must compare against the
 * bare `::1`, so strip first. Idempotent for non-IPv6 / already-bare hosts.
 */
export function stripIpv6Brackets(host: string): string {
  if (host.length >= 2 && host.startsWith('[') && host.endsWith(']')) {
    return host.slice(1, -1);
  }
  return host;
}

/** Lowercase, strip a single trailing dot, convert IDNA to A-labels. */
export function normalizeHost(host: string): string {
  let h = stripIpv6Brackets(host).trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h.startsWith('*.')) {
    const suffix = domainToASCII(h.slice(2));
    return suffix ? `*.${suffix}` : h;
  }
  // IPv6 literals (e.g. "::1") are not domain names — domainToASCII would
  // mangle them. Pass them through after bracket-stripping + lowercasing.
  if (h.includes(':')) return h;
  const ascii = domainToASCII(h);
  return ascii || h;
}

/** True when a wildcard suffix is itself on the Public Suffix List. */
export function isPublicSuffixWildcard(pattern: string): boolean {
  const normalized = normalizeHost(pattern);
  if (!normalized.startsWith('*.')) return false;
  const suffix = normalized.slice(2);
  const options = { allowPrivateDomains: true };
  // A public suffix has no registrable domain. `getPublicSuffix` handles
  // multi-label and private rules such as co.uk and github.io; `getDomain`
  // distinguishes registrable names such as example.co.uk.
  return getPublicSuffix(suffix, options) === suffix && getDomain(suffix, options) === null;
}

/**
 * Match `host` against a grant `pattern`.
 * - "api.example.com"  → exact only.
 * - "*.example.com"    → subdomains only, NOT the apex.
 * - public-suffix wildcard → never matches.
 */
export function hostMatches(pattern: string, host: string): boolean {
  const p = normalizeHost(pattern);
  const h = normalizeHost(host);
  if (isPublicSuffixWildcard(p)) return false;
  if (p.startsWith('*.')) {
    const suffix = p.slice(2);
    return h.endsWith('.' + suffix) && h !== suffix;
  }
  return h === p;
}

/** Percent-decode, collapse duplicate slashes, resolve . and .. segments. */
export function normalizePath(p: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    decoded = p; // leave undecodable input as-is; it won't match a sane prefix
  }
  const collapsed = decoded.replace(/\/{2,}/g, '/');
  const parts = collapsed.split('/');
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return '/' + out.join('/');
}

/** True if normalized `path` starts with normalized `prefix` on a segment boundary. */
export function pathMatchesPrefix(prefix: string, path: string): boolean {
  const np = normalizePath(prefix);
  const npath = normalizePath(path);
  if (np === '/') return true;
  return npath === np || npath.startsWith(np.endsWith('/') ? np : np + '/');
}
