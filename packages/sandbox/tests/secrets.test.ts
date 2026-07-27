import { describe, it, expect } from 'vitest';
import { MapSecretProvider, redactSecrets } from '../src/secrets.js';
import type { InstallationIdentity } from '../src/types.js';

const identity: InstallationIdentity = {
  installationId: 'u1', digest: 'sha256:a', snapshotRef: 'sha256:a', name: 'weather',
};

describe('MapSecretProvider', () => {
  it('resolves an installation-scoped secret, then a global fallback', async () => {
    const p = new MapSecretProvider(new Map([
      ['u1:WTR_API_KEY', 'scoped-secret'],
      ['GLOBAL_KEY', 'global-secret'],
    ]));
    expect(await p.resolve(identity, 'WTR_API_KEY')).toBe('scoped-secret');
    expect(await p.resolve(identity, 'GLOBAL_KEY')).toBe('global-secret');
    expect(await p.resolve(identity, 'MISSING')).toBeUndefined();
  });
});

describe('redactSecrets', () => {
  it('replaces secret values in nested objects/strings', async () => {
    const p = new MapSecretProvider(new Map([['u1:WTR_API_KEY', 'topsecret']]));
    const leaky = { result: 'token is topsecret ok', nested: { auth: 'topsecret' } };
    const clean = await redactSecrets(leaky, p, identity, ['WTR_API_KEY']);
    expect(JSON.stringify(clean)).not.toContain('topsecret');
    expect(JSON.stringify(clean)).toContain('[REDACTED]');
  });

  it('redacts secrets containing JSON-escaped characters (quotes, backslashes)', async () => {
    // Secret contains a literal " and \ — the old JSON.stringify approach escaped
    // these and the raw secret never matched, leaking the value.
    const secret = 'to"p\\secret';
    const p = new MapSecretProvider(new Map([['u1:TRICKY', secret]]));
    const leaky = { result: `token is ${secret} ok`, nested: { deep: [secret, 'safe'] } };
    const clean = await redactSecrets(leaky, p, identity, ['TRICKY']);
    const serialized = JSON.stringify(clean);
    expect(serialized).not.toContain('to"p');
    expect(serialized).not.toContain('p\\secret');
    expect(serialized).toContain('[REDACTED]');
  });

  it('returns input unchanged when input is null or undefined', async () => {
    const p = new MapSecretProvider(new Map([['u1:K', 's']]));
    await expect(redactSecrets(null, p, identity, ['K'])).resolves.toBeNull();
    await expect(redactSecrets(undefined, p, identity, ['K'])).resolves.toBeUndefined();
  });
});
