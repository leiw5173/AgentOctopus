---
'@agentoctopus/sandbox-vm-native': patch
---

fix(sandbox-vm-native): correct the libkrun source tarball SHA pin

The pinned SHA-256 for the libkrun v1.19.4 source tarball did not match the
actual codeload tarball for commit `728df812` (the download succeeded but the
checksum mismatched), so `vendor-libkrun` died before building libkrun —
failing `produce-linux-artifacts`. Re-verified the real digest against a
deterministic double download (`a0dfa34a…`). This is a trust-root correction
(user-reviewed): the pin is a trust anchor, and GitHub codeload tarballs are
generated on demand, so their byte-level digest can drift over time. A more
robust anchor (content-hash of the extracted tree rather than the tarball
bytes) is a worthwhile follow-up.
