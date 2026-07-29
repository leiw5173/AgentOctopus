// packages/sandbox/tests/vm/env.test.ts
import { describe, it, expect } from 'vitest';
import { buildGuestEnv } from '../../src/vm/env.js';

describe('vm guest env', () => {
  it('trusted proxy/CA vars override untrusted spec.env on collision', () => {
    const env = buildGuestEnv(
      { HTTP_PROXY: 'http://evil:8080', FOO: 'bar' },
      'http://127.0.0.1:1234',
      '/etc/skill-ca/ca.pem',
    );
    const map = Object.fromEntries(env.map((e) => e.split('=')));
    expect(map.HTTP_PROXY).toBe('http://127.0.0.1:1234'); // overridden
    expect(map.FOO).toBe('bar'); // untrusted preserved
    expect(map.HTTPS_PROXY).toBe('http://127.0.0.1:1234');
  });

  it('includes lower-case proxy variants', () => {
    const env = buildGuestEnv({}, 'http://127.0.0.1:1234', '/etc/skill-ca/ca.pem');
    const map = Object.fromEntries(env.map((e) => e.split('=')));
    expect(map.http_proxy).toBe('http://127.0.0.1:1234');
    expect(map.https_proxy).toBe('http://127.0.0.1:1234');
    expect(map.all_proxy).toBe('http://127.0.0.1:1234');
    expect(map.no_proxy).toBe('');
  });

  it('points SSL_CERT_FILE + NODE_EXTRA_CA_CERTS + REQUESTS_CA_BUNDLE at the CA bundle', () => {
    const env = buildGuestEnv({}, 'http://127.0.0.1:1234', '/etc/skill-ca/ca.pem');
    const map = Object.fromEntries(env.map((e) => e.split('=')));
    expect(map.SSL_CERT_FILE).toBe('/etc/skill-ca/ca.pem');
    expect(map.NODE_EXTRA_CA_CERTS).toBe('/etc/skill-ca/ca.pem');
    expect(map.REQUESTS_CA_BUNDLE).toBe('/etc/skill-ca/ca.pem');
  });
});
