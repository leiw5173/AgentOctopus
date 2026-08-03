---
"@agentoctopus/sandbox": patch
---

chore(sandbox): rotate the VM release-manifest trust root

The previous Ed25519 public key committed in `release-key.ts` had no
recoverable private seed — the CI secret `OCTOPUS_VM_RELEASE_PRIVATE_KEY`
was never populated, so the vm-lane "Sign release manifest" step failed
closed (`OCTOPUS_VM_RELEASE_PRIVATE_KEY is not set`) on every same-repo
run even after the G1/G2 qualification gates went green.

Per the documented ROTATION PROCEDURE: a new Ed25519 keypair was
generated, the compiled-in `RELEASE_PUBLIC_KEY_BASE64` constant is
replaced with the new base64 DER SPKI public key, and the CI secret is
rotated to the new base64 seed. The private seed remains custody-only
(GitHub secret, never in the repository). Signatures produced under the
old key now fail closed (`bad-signature`) — by design.
