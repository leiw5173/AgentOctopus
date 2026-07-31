/**
 * F5 — sign-release-manifest.mjs private-key import regression tests.
 *
 * The CI secret OCTOPUS_VM_RELEASE_PRIVATE_KEY may be a base64 32-byte Ed25519
 * seed (the documented form) or a PKCS8 PEM. The seed route previously built
 * an OKP JWK carrying only `d` — Node rejects that with ERR_CRYPTO_INVALID_JWK
 * ("Invalid JWK OKP key"), so a seed secret could never sign. The fix wraps
 * the seed in a PKCS8 DER structure (RFC 5208). These tests spawn the real
 * script with --print-public for both secret forms and assert the derived
 * public key matches the canonical SPKI of the same keypair.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'sign-release-manifest.mjs');

function printPublic(secret: string): string {
  return execFileSync(process.execPath, [SCRIPT, '--print-public'], {
    env: { ...process.env, OCTOPUS_VM_RELEASE_PRIVATE_KEY: secret },
    encoding: 'utf8',
  }).trim();
}

describe('sign-release-manifest.mjs private-key import (F5)', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const canonicalSpki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const pkcs8Der = privateKey.export({ type: 'pkcs8', format: 'der' });
  // The seed is the innermost OCTET STRING payload — the last 32 PKCS8 bytes.
  const seedB64 = Buffer.from(pkcs8Der.subarray(pkcs8Der.length - 32)).toString('base64');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  it('imports a base64 32-byte seed and derives the canonical public key', () => {
    expect(printPublic(seedB64)).toBe(canonicalSpki);
  });

  it('imports a PKCS8 PEM and derives the canonical public key', () => {
    expect(printPublic(pem)).toBe(canonicalSpki);
  });

  it('seed form and PEM form of the same key derive identical public keys', () => {
    expect(printPublic(seedB64)).toBe(printPublic(pem));
  });
});
