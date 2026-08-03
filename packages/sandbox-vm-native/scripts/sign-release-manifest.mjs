#!/usr/bin/env node
/**
 * sign-release-manifest.mjs — Ed25519-sign the outer release manifest.
 *
 * The outer release manifest is the gate-manifest.json body (produced by
 * run-vm-gates.mjs, Task 16 Step 1) wrapped with its signature. The backend
 * verifies it at launch time with verifyOuterReleaseManifest()
 * (gate-manifest.ts:59-71) against the COMPILED-IN public key in
 * packages/sandbox/src/vm/release-key.ts.
 *
 * Key model:
 *   - The PRIVATE key is a CI secret (OCTOPUS_VM_RELEASE_PRIVATE_KEY), base64
 *     raw Ed25519 Seed (32 bytes) or PKCS8. It is NEVER committed. If the env
 *     var is absent, the script generates a throwaway keypair, signs with it,
 *     and prints the public key to stdout with a clear instruction to commit
 *     it to release-key.ts — this is the first-run bootstrap path.
 *   - The PUBLIC key is the constant in release-key.ts. This script can
 *     `--print-public` the key derived from the provided private key so the
 *     operator can paste it into release-key.ts (the constant, not the env
 *     fallback). Once committed, key rotation = a new native package release.
 *
 * Signature: detached Ed25519 over the canonical JSON of the manifest body
 * (the gate-manifest.json content, parsed and re-stringified — matching
 * computeManifestDigest's canonicalization, i.e. JSON.stringify of the
 * parsed object so key order is stable). The signature is base64.
 *
 * Output:
 *   prebuilds/<platform>/release-manifest.json       — the raw canonical gate-manifest body
 *                                                       (the EXACT bytes the signature covers).
 *   prebuilds/<platform>/release-manifest.json.sig   — base64 Ed25519 signature over those bytes.
 *   prebuilds/<platform>/outer-release-manifest.json — enveloped bundle
 *                                                       { manifest, signature, signedBy, signedAt }
 *                                                       for human inspection; NOT what the
 *                                                       verifier reads.
 *
 * The verifier (gate-manifest.ts:verifyOuterReleaseManifest) reads TWO files
 * (release-manifest.json + release-manifest.json.sig) and verifies the signature
 * over the raw body bytes. The enveloped outer-*.json is a readable artifact
 * only — feeding it as releaseManifestPath would verify the signature over the
 * ENVELOPE json (which includes signature/signedAt), not the body, and always
 * fail. The detached pair is the producer↔verifier contract.
 *
 * Fail-closed everywhere: missing private key on a non-bootstrap run, missing
 * gate-manifest.json, or signature verification failure exits non-zero.
 *
 * Usage:
 *   node scripts/sign-release-manifest.mjs                     # sign (needs OCTOPUS_VM_RELEASE_PRIVATE_KEY)
 *   node scripts/sign-release-manifest.mjs --print-public      # print derived public key
 *   node scripts/sign-release-manifest.mjs --bootstrap         # generate throwaway keypair, sign, print public key to commit
 */
import { generateKeyPairSync, sign, verify, createPublicKey, createPrivateKey } from 'node:crypto';
import { existsSync, createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const PREBUILDS_DIR = path.join(PKG_ROOT, 'prebuilds');

function die(msg, exitCode = 1) {
  console.error(`sign-release-manifest: ERROR: ${msg}`);
  process.exit(exitCode);
}

function platformArch() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  die(`unsupported host '${platform}-${arch}' — release manifest is signed on darwin-arm64 and linux-x64 lanes only.`);
}

// ---------------------------------------------------------------------------
// Key handling. The private key arrives as a CI secret in one of two forms:
//   1. base64 raw Ed25519 seed (32 bytes) — we wrap it into a KeyObject.
//   2. PKCS8 PEM string.
// We derive the public key from it so the operator can confirm it matches
// the compiled-in constant.
// ---------------------------------------------------------------------------

function loadPrivateKeyFromEnv() {
  const raw = process.env.OCTOPUS_VM_RELEASE_PRIVATE_KEY;
  if (!raw) return null;
  // Try PKCS8 PEM first.
  if (raw.includes('-----BEGIN')) {
    try { return createPrivateKey(raw); } catch { /* fall through */ }
  }
  // Treat as base64 raw seed (32 bytes).
  try {
    const seed = Buffer.from(raw, 'base64');
    if (seed.length === 32) {
      // Ed25519 raw seed → KeyObject via a PKCS8 DER wrap (RFC 5208). Node has
      // no direct seed import, and the d-only OKP JWK route is rejected with
      // ERR_CRYPTO_INVALID_JWK — see deriveEd25519FromSeed.
      const { privateKey } = deriveEd25519FromSeed(seed);
      return privateKey;
    }
  } catch { /* fall through */ }
  // Last resort: maybe it's a base64 PKCS8 DER.
  try {
    const der = Buffer.from(raw, 'base64');
    return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } catch {
    die('OCTOPUS_VM_RELEASE_PRIVATE_KEY is set but could not be parsed as PEM, base64 seed (32 bytes), or base64 PKCS8 DER.');
  }
}

// Derive an Ed25519 keypair from a 32-byte seed. Node's crypto has no direct
// seed import, and importing an OKP JWK carrying only `d` (no `x`) throws
// ERR_CRYPTO_INVALID_JWK ("Invalid JWK OKP key") — Node requires both members.
// The working route is a PKCS8 DER wrap (RFC 5208): the Ed25519 private key
// is an OCTET STRING holding the 32-byte seed, nested in the PKCS8 structure.
// Verified byte-identical to a canonical PKCS8 export of the same key.
function deriveEd25519FromSeed(seed) {
  if (seed.length !== 32) throw new Error('seed must be 32 bytes');
  const pkcs8 = Buffer.concat([
    Buffer.from([0x30, 0x2e]),                                // SEQUENCE (46 bytes)
    Buffer.from([0x02, 0x01, 0x00]),                          // INTEGER 0 (version)
    Buffer.from([0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70]),  // SEQUENCE { OID 1.3.101.112 (id-Ed25519) }
    Buffer.from([0x04, 0x22, 0x04, 0x20]), seed,              // OCTET STRING { OCTET STRING { seed } }
  ]);
  const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey);
  return { publicKey, privateKey };
}

function publicKeyToBase64Spki(pubKey) {
  // verifyOuterReleaseManifest expects the public key as base64 DER SPKI
  // (gate-manifest.ts:64: format:'der', type:'spki'). Export and base64-encode.
  const spkiDer = pubKey.export({ type: 'spki', format: 'der' });
  return spkiDer.toString('base64');
}

// ---------------------------------------------------------------------------
// Sign / verify.
// ---------------------------------------------------------------------------

function signManifest(manifestBody, privateKey) {
  // Canonical JSON: JSON.stringify of the parsed object (stable key order
  // for a given object shape). This matches computeManifestDigest's
  // canonicalization (gate-manifest.ts:30). The verifier reads these exact
  // bytes from release-manifest.json, so what we sign here is what verifies.
  const canonical = Buffer.from(JSON.stringify(manifestBody), 'utf8');
  const signature = sign(null, canonical, privateKey);
  return { canonical, signature: signature.toString('base64') };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const printPublic = args.has('--print-public');
const bootstrap = args.has('--bootstrap');

const platform = platformArch();
const targetDir = path.join(PREBUILDS_DIR, platform);
const gateManifestPath = path.join(targetDir, 'gate-manifest.json');
const outerManifestPath = path.join(targetDir, 'outer-release-manifest.json');

let privateKey = loadPrivateKeyFromEnv();

if (bootstrap && !privateKey) {
  // First-run path: generate a throwaway keypair, sign with it, print the
  // public key for the operator to commit to release-key.ts. This is the
  // ONLY path that produces a new persistent key — production lanes always
  // pass OCTOPUS_VM_RELEASE_PRIVATE_KEY.
  const { publicKey, privateKey: kp } = generateKeyPairSync('ed25519');
  privateKey = kp;
  const pubB64 = publicKeyToBase64Spki(publicKey);
  console.error('sign-release-manifest: BOOTSTRAP — generated a throwaway Ed25519 keypair.');
  console.error('  The public key (base64 DER SPKI) to commit to packages/sandbox/src/vm/release-key.ts:');
  console.error(`    ${pubB64}`);
  console.error('  Replace the placeholder constant with this value, then run again with');
  console.error('  OCTOPUS_VM_RELEASE_PRIVATE_KEY set to the private seed for production signs.');
}

if (printPublic) {
  if (!privateKey) die('OCTOPUS_VM_RELEASE_PRIVATE_KEY not set — cannot derive public key.');
  const publicKey = createPublicKey(privateKey);
  console.log(publicKeyToBase64Spki(publicKey));
  process.exit(0);
}

if (!privateKey) {
  die('OCTOPUS_VM_RELEASE_PRIVATE_KEY not set. Pass --bootstrap to generate a throwaway keypair for first-run, or set the CI secret for production signs.');
}

if (!existsSync(gateManifestPath)) {
  die(`gate-manifest.json not found at ${gateManifestPath}\n` +
    '  Run run-vm-gates.mjs first (Task 16 Step 1).');
}

const gateManifest = JSON.parse(await fs.readFile(gateManifestPath, 'utf8'));

// Sign the canonical body (the full gate-manifest object, including
// manifestDigest — the signature covers the digest, so any tampering with
// the body that changes the digest is caught by BOTH the digest check AND
// the signature).
const { canonical, signature } = signManifest(gateManifest, privateKey);

// Self-verify: prove the signature validates against the derived public key
// before writing it. This catches a malformed private key early. Verify over
// the SAME canonical bytes the verifier will read from release-manifest.json.
const publicKey = createPublicKey(privateKey);
const ok = verify(null, canonical, publicKey, Buffer.from(signature, 'base64'));
if (!ok) die('internal error: signature failed self-verification — the private key is malformed.');

// Detached pair (producer↔verifier contract): write the raw canonical body the
// signature covers, plus the base64 signature. The verifier reads both files
// and verifies over the body bytes. Atomic per-file (tmp+rename) so a crash
// never leaves a half-written manifest that verifies against stale bytes.
const detachedManifestPath = path.join(targetDir, 'release-manifest.json');
const detachedSigPath = path.join(targetDir, 'release-manifest.json.sig');

async function writeAtomic(filePath, contents) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, contents);
  await fs.rename(tmp, filePath);
}
await writeAtomic(detachedManifestPath, canonical);
await writeAtomic(detachedSigPath, signature + '\n');

// Enveloped bundle (human-readable only — NOT read by the verifier). Kept so an
// operator can inspect manifest + signature + signer in one file.
const outer = {
  schemaVersion: 1,
  manifest: gateManifest,
  signature,
  signedBy: 'octopus-vm-release',
  signedAt: new Date().toISOString(),
};
await writeAtomic(outerManifestPath, JSON.stringify(outer, null, 2) + '\n');

console.log('sign-release-manifest: OK');
console.log(`  detached manifest: ${detachedManifestPath}`);
console.log(`  detached signature: ${detachedSigPath}`);
console.log(`  enveloped bundle:  ${outerManifestPath} (readable only)`);
console.log(`  signature: ${signature.slice(0, 32)}...`);
console.log(`  pubkey:    ${publicKeyToBase64Spki(publicKey).slice(0, 32)}...`);
console.log('  Verify with verifyOuterReleaseManifest() (gate-manifest.ts) at launch time.');
