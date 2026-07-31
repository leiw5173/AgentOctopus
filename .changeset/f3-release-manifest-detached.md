---
"@agentoctopus/sandbox": patch
"@agentoctopus/sandbox-vm-native": patch
"@agentoctopus/core": patch
---

Fix release-manifest signature producer↔verifier mismatch (F3).

The producer wrote one enveloped `outer-release-manifest.json`
(`{ manifest, signature, signedBy, signedAt }`) but the verifier read two
files and verified the signature over the FIRST file's bytes — feeding the
envelope as `releaseManifestPath` verified the signature over the envelope
JSON (which includes signature/signedAt), not the inner body, so verification
always failed. The assembly also set no default paths, so production never
wired the verifier at all.

Switch to a detached-signature scheme matching the verifier's contract: the
signer writes `release-manifest.json` (raw canonical gate-manifest body — the
exact bytes the signature covers) + `release-manifest.json.sig` (base64
Ed25519), keeping the enveloped bundle as a human-readable artifact only. The
assembly defaults both paths to `prebuilds/<platform>/`. Engine `probe()` now
treats a PRESENT manifest with `no-key` (empty trust root placeholder) as
fail-closed `signature-invalid` rather than soft `missing` — a present-but-
unverifiable signature is not a capability probe, so the bootstrap fails loud
on any real release until `RELEASE_PUBLIC_KEY_BASE64` is committed. Absent
manifest files still soft-fall to `missing` (dev box).
