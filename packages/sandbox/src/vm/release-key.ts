// packages/sandbox/src/vm/release-key.ts
// Compiled-in Ed25519 public key (release-manifest trust root). NOT fetched at
// runtime, NOT read from config, NOT overridable by env. Key rotation = a new
// native package release.
//
// TODO: replace this placeholder with the real base64 DER SPKI Ed25519 public key
// produced by `sign-release-manifest.mjs --bootstrap` (or the release CI task)
// before the first production release that exercises VM release signing. Until
// then the VM backend treats a present-but-unsigned release manifest as an
// invalid signature and fails closed.
export const RELEASE_PUBLIC_KEY_BASE64 = '';

// EXPLICIT TEST SEAM ONLY. Tests and pre-release CI may inject a throwaway
// Ed25519 public key via OCTOPUS_VM_RELEASE_KEY_TEST. This is NOT the
// production trust root and must never be treated as such. Once the real key is
// committed above, this seam is ignored in production.
export const RELEASE_PUBLIC_KEY_TEST_SEAM = process.env.OCTOPUS_VM_RELEASE_KEY_TEST ?? '';
