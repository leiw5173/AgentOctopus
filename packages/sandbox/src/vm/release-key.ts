// packages/sandbox/src/vm/release-key.ts
// Compiled-in Ed25519 public key (release-manifest trust root). NOT fetched at
// runtime, NOT read from config, NOT overridable by env. Key rotation = a new
// native package release. The real key is generated in the release task and
// committed here; tests use a throwaway keypair (injected via a test seam).
export const RELEASE_PUBLIC_KEY_BASE64 = process.env.OCTOPUS_VM_RELEASE_KEY_TEST ?? '';
// Production: a constant base64 string. Test seam: env var lets tests inject a key.
