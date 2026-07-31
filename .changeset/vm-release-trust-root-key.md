---
'@agentoctopus/sandbox': patch
---

feat(sandbox): commit the VM release trust-root public key

Replaces the empty `RELEASE_PUBLIC_KEY_BASE64` placeholder in release-key.ts
with the production Ed25519 public key (base64 DER SPKI) matching the CI
signing secret `OCTOPUS_VM_RELEASE_PRIVATE_KEY`. Signed release manifests
shipped in the native package now verify at launch; a present-but-unverifiable
manifest still fails closed (`signature-invalid`), and an absent pair still
degrades softly (`missing`). The private seed is custody-only (GitHub secret,
never committed). Adds trust-root unit tests and release-chain documentation
(TEST_INSTRUCTIONS.md S18, docs/deployment/security.md).
