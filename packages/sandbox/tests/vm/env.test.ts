// packages/sandbox/tests/vm/env.test.ts
import { describe, it, expect } from 'vitest';
import { buildGuestEnv } from '../../src/vm/env.js';

const toMap = (env: string[]) => Object.fromEntries(env.map((e) => e.split('=')));

describe('vm guest env', () => {
  it('trusted proxy/CA vars override allowlisted spec.env on collision', () => {
    const env = buildGuestEnv(
      { HTTP_PROXY: 'http://evil:8080' },
      'http://127.0.0.1:1234',
      '/etc/skill-ca/ca.pem',
    );
    const map = toMap(env);
    expect(map.HTTP_PROXY).toBe('http://127.0.0.1:1234'); // overridden
    expect(map.HTTPS_PROXY).toBe('http://127.0.0.1:1234');
  });

  it('strips non-allowlisted caller env (credential containment)', () => {
    const env = buildGuestEnv(
      { FOO: 'bar', AWS_SECRET_ACCESS_KEY: 'leak', OCTOPUS_LEAK_CANARY_x1: 'secret' },
      'http://127.0.0.1:1234',
      '/etc/skill-ca/ca.pem',
    );
    const map = toMap(env);
    // Untrusted caller vars must NOT reach the guest.
    expect(map.FOO).toBeUndefined();
    expect(map.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(map.OCTOPUS_LEAK_CANARY_x1).toBeUndefined();
  });

  it('passes only the SAFE probe-orchestration allowlist through', () => {
    const env = buildGuestEnv(
      {
        PROBE_ACTION: 'env-names',
        PROBE_HOST: 'example.com',
        PROBE_PORT: '443',
        HOST_CANARY_PATH: '/etc/passwd',
      },
      'http://127.0.0.1:1234',
      '/etc/skill-ca/ca.pem',
    );
    const map = toMap(env);
    expect(map.PROBE_ACTION).toBe('env-names');
    expect(map.PROBE_HOST).toBe('example.com');
    expect(map.PROBE_PORT).toBe('443');
    expect(map.HOST_CANARY_PATH).toBe('/etc/passwd');
  });

  it('includes lower-case proxy variants', () => {
    const env = buildGuestEnv({}, 'http://127.0.0.1:1234', '/etc/skill-ca/ca.pem');
    const map = toMap(env);
    expect(map.http_proxy).toBe('http://127.0.0.1:1234');
    expect(map.https_proxy).toBe('http://127.0.0.1:1234');
    expect(map.all_proxy).toBe('http://127.0.0.1:1234');
    expect(map.no_proxy).toBe('');
  });

  it('points SSL_CERT_FILE + NODE_EXTRA_CA_CERTS + REQUESTS_CA_BUNDLE at the CA bundle', () => {
    const env = buildGuestEnv({}, 'http://127.0.0.1:1234', '/etc/skill-ca/ca.pem');
    const map = toMap(env);
    expect(map.SSL_CERT_FILE).toBe('/etc/skill-ca/ca.pem');
    expect(map.NODE_EXTRA_CA_CERTS).toBe('/etc/skill-ca/ca.pem');
    expect(map.REQUESTS_CA_BUNDLE).toBe('/etc/skill-ca/ca.pem');
  });
});
