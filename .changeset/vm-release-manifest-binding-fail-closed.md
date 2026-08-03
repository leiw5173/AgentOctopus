---
'@agentoctopus/sandbox-vm-native': patch
'@agentoctopus/core': patch
---

fix(sandbox-vm-native): bind the release signature to the loaded gate manifest and fail closed on deletion

- probe() now parses the Ed25519-signed release-manifest body after signature
  verification and requires canonical-digest equality with the gate manifest
  actually loaded, closing the mixed-state attack (a legitimately-signed old
  release manifest + swapped gate manifest / TCB / binaries).
- A half pair (exactly one of release-manifest.json / .sig present) now fails
  closed unconditionally, and a file deleted between the existence check and
  the read (TOCTOU) fails closed instead of soft-degrading.
- New engine option requireReleaseSignature, set by core's production
  buildEngineOpts, makes a release build fail closed when the signed pair is
  absent instead of degrading to unsigned dev mode. Dev boxes and CI harnesses
  that build engine opts without the flag keep the soft 'missing' path.
