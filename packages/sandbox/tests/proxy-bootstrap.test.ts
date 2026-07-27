import { describe, it, expect } from 'vitest';
import { provisionSecrets } from '../src/proxy/bootstrap.js';
import { MapSecretProvider } from '../src/secrets.js';
import type { SandboxPolicy } from '../src/policy.js';
import type { InstallationIdentity } from '../src/types.js';

const identity: InstallationIdentity = { installationId: 'u1', digest: 'sha256:a', snapshotRef: 'sha256:a', name: 'w' };

const policy: SandboxPolicy = {
  hosts: ['wttr.in'],
  credentials: [
    { key: 'WTR_API_KEY', host: 'wttr.in', port: 443, scheme: 'https', methods: ['GET'], pathPrefix: '/data', header: 'Authorization' },
    { key: 'MISSING_KEY', host: 'wttr.in', port: 443, scheme: 'https', methods: ['GET'], pathPrefix: '/', header: 'X-Key' },
  ],
  resources: { memoryBytes: 512 * 1024 * 1024, timeoutMs: 30000, cpus: 0.5 },
  denied: { hosts: [], credentials: [] },
};

describe('provisionSecrets', () => {
  it('resolves only grant-scoped keys that exist, skipping missing ones', async () => {
    const provider = new MapSecretProvider(new Map([['u1:WTR_API_KEY', 'real-secret']]));
    const secrets = await provisionSecrets(provider, identity, policy);
    expect(secrets).toEqual({ WTR_API_KEY: 'real-secret' });
    expect(secrets).not.toHaveProperty('MISSING_KEY');
  });

  it('returns an empty map when no credentials are granted', async () => {
    const provider = new MapSecretProvider(new Map([['u1:WTR_API_KEY', 'real-secret']]));
    const secrets = await provisionSecrets(provider, identity, { ...policy, credentials: [] });
    expect(secrets).toEqual({});
  });
});
