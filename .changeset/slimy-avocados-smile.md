---
"@agentoctopus/sandbox": patch
"@agentoctopus/sandbox-vm-native": patch
---

Fail-closed VM release-signature verification and compiled-in trust root.

- `RELEASE_PUBLIC_KEY_BASE64` is now a placeholder constant in `packages/sandbox/src/vm/release-key.ts`; the real Ed25519 public key must be committed before the first production release that exercises VM release signing.
- The test seam `OCTOPUS_VM_RELEASE_KEY_TEST` is renamed/exposed as `RELEASE_PUBLIC_KEY_TEST_SEAM` and is explicitly NOT the production source.
- `verifyOuterReleaseManifest` returns a discriminated result (`no-key` | `bad-signature` | `ok`) so callers can distinguish an unsigned dev build from an invalid production signature.
- `VmEngineImpl.probe()` now fails closed (`available: false`, `releaseManifest: 'signature-invalid'`) when both manifest and signature files are present but the signature is invalid; absent files still probe as `missing` with `available: true`.
