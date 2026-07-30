---
'@agentoctopus/sandbox-vm-native': patch
'@agentoctopus/core': patch
---

fix(sandbox-vm-native): unified vm-tcb-manifest with imageBuilder (HI-3)

- `packages/sandbox-vm-native/scripts/build-vm-helper.mjs` now builds the
  `vm-image-builder` TCB artifact (from `src/vm-image-builder.c`) and writes
  its per-artifact manifest, then aggregates helper/libkrun/libkrunfw/imageBuilder
  into ONE combined `prebuilds/<platform>/vm-tcb-manifest.json` with each entry
  `{sha256, size, mode}`.
- `packages/sandbox-vm-native/scripts/run-vm-gates.mjs` reads artifact refs from
  the combined `vm-tcb-manifest.json` instead of four separate per-artifact files.
- New shared helper `packages/sandbox-vm-native/scripts/tcb-manifest.mjs` exports
  `buildTcbManifest()` (producer), `readArtifactRefsFromTcbManifest()` (gate),
  and `readPerArtifactEntry()`.
- Fail-closed invariant: if the imageBuilder artifact or its per-artifact manifest
  is absent/malformed, `buildTcbManifest()` throws and writes no combined manifest.
  If the combined manifest is missing or malformed, `readArtifactRefsFromTcbManifest()`
  throws. `verifyVmTcb` rejection during the build self-check is now fatal.
- `packages/core/src/sandbox-vm-assembly.ts` defaults `tcbManifestPath` to
  `prebuilds/<platform>/vm-tcb-manifest.json` to match the unified manifest.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
