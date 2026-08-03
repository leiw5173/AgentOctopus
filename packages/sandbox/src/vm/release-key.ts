// packages/sandbox/src/vm/release-key.ts
// Compiled-in Ed25519 public key (release-manifest trust root). NOT fetched at
// runtime, NOT read from config, NOT overridable by env. Key rotation = a new
// native package release.
//
// This is the production trust root for the outer release manifest signature
// (verifyOuterReleaseManifest, gate-manifest.ts). It matches the CI signing
// secret OCTOPUS_VM_RELEASE_PRIVATE_KEY (a base64 32-byte Ed25519 seed; the
// signer derives the keypair via the PKCS8 wrap in sign-release-manifest.mjs).
// The private seed is custody-only — it lives in the GitHub secret and
// nowhere in this repository.
//
// ROTATION PROCEDURE: generate a new Ed25519 keypair, replace this constant
// with the new base64 DER SPKI public key, rotate OCTOPUS_VM_RELEASE_PRIVATE_KEY
// to the new base64 seed, and ship a release. Old signatures fail closed
// ('bad-signature') immediately after rotation — by design.
//
// Fail-closed semantics: a PRESENT release-manifest.json + .sig pair that does
// not verify against this key (or verifies against nothing, 'no-key') makes
// engine.probe() return available:false + releaseManifest:'signature-invalid'.
// A present-but-unverifiable signature is not a capability probe. When no
// release manifest is present (dev box, unsigned build), probe() stays soft
// with releaseManifest:'missing'.
export const RELEASE_PUBLIC_KEY_BASE64 = 'MCowBQYDK2VwAyEAAtkDsssxFCnx8ViSDgE/Omo3aXVtp5i8OB2dC+Q3vF4=';

// EXPLICIT TEST SEAM ONLY. Tests and pre-release CI may inject a throwaway
// Ed25519 public key via OCTOPUS_VM_RELEASE_KEY_TEST. This is NOT the
// production trust root and must never be treated as such. The production key
// above takes precedence: the seam is consulted only when the compiled-in key
// is empty (see verifyOuterReleaseManifest).
export const RELEASE_PUBLIC_KEY_TEST_SEAM = process.env.OCTOPUS_VM_RELEASE_KEY_TEST ?? '';
