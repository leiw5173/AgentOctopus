// packages/sandbox/src/vm/release-key.ts
// Compiled-in Ed25519 public key (release-manifest trust root). NOT fetched at
// runtime, NOT read from config, NOT overridable by env. Key rotation = a new
// native package release.
//
// TODO: replace this placeholder with the real base64 DER SPKI Ed25519 public key
// produced by `sign-release-manifest.mjs --bootstrap` (or the release CI task)
// before the first production release that ships a signed release manifest. Until
// then: a PRESENT release-manifest.json + .sig pair with this empty trust root
// makes engine.probe() return available:false + releaseManifest:'signature-invalid'
// (the 'no-key' result is fail-closed when a manifest is present — a present-but-
// unverifiable signature is not a capability probe). When no release manifest is
// present (dev box), probe() stays soft with releaseManifest:'missing'.
export const RELEASE_PUBLIC_KEY_BASE64 = '';

// EXPLICIT TEST SEAM ONLY. Tests and pre-release CI may inject a throwaway
// Ed25519 public key via OCTOPUS_VM_RELEASE_KEY_TEST. This is NOT the
// production trust root and must never be treated as such. Once the real key is
// committed above, this seam is ignored in production.
export const RELEASE_PUBLIC_KEY_TEST_SEAM = process.env.OCTOPUS_VM_RELEASE_KEY_TEST ?? '';
