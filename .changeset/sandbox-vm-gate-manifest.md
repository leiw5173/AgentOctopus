---
"@agentoctopus/sandbox": minor
---

feat(sandbox): VM gate-manifest + outer release-manifest verification — self-hashed gate manifest (manifestDigest over body excluding the field), fail-closed on tampered body / G1 or G2 NO-GO / empty qualifiedRootfsDigests / artifact digest mismatch; Ed25519 outer release-manifest signature verification against compiled-in public key.
