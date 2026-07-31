/**
 * F6 — release-manifest trust root (release-key.ts) tests.
 *
 * The production private key is custody-only (GitHub secret) and NEVER
 * appears here — these tests prove the committed public key is structurally
 * valid and that verifyOuterReleaseManifest actually consults it (fail-closed
 * 'bad-signature' for any foreign signature, never a silent pass).
 */
import { describe, it, expect } from 'vitest';
import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { RELEASE_PUBLIC_KEY_BASE64 } from '../../src/vm/release-key.js';
import { verifyOuterReleaseManifest } from '../../src/vm/gate-manifest.js';

describe('release trust root (F6)', () => {
  it('RELEASE_PUBLIC_KEY_BASE64 is committed (no longer the empty placeholder)', () => {
    expect(RELEASE_PUBLIC_KEY_BASE64).not.toBe('');
  });

  it('is a structurally valid Ed25519 SPKI public key', () => {
    const key = createPublicKey({
      key: Buffer.from(RELEASE_PUBLIC_KEY_BASE64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    expect(key.asymmetricKeyType).toBe('ed25519');
    // SPKI DER re-export round-trips byte-identically (canonical encoding).
    const reExport = key.export({ type: 'spki', format: 'der' }).toString('base64');
    expect(reExport).toBe(RELEASE_PUBLIC_KEY_BASE64);
  });

  it('rejects a signature from a foreign key (fail-closed bad-signature)', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const body = Buffer.from(JSON.stringify({ platform: 'darwin-arm64', schemaVersion: 1 }));
    const signature = sign(null, body, privateKey);
    const result = verifyOuterReleaseManifest(body, signature);
    expect(result.ok).toBe(false);
    // 'bad-signature' (not 'no-key') proves the committed key was consulted.
    expect(result.reason).toBe('bad-signature');
  });

  it('rejects a valid foreign signature over a tampered body', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const body = Buffer.from(JSON.stringify({ platform: 'darwin-arm64', schemaVersion: 1 }));
    const signature = sign(null, body, privateKey);
    const tampered = Buffer.from(JSON.stringify({ platform: 'linux-x64', schemaVersion: 1 }));
    const result = verifyOuterReleaseManifest(tampered, signature);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad-signature');
  });
});
