---
"@agentoctopus/sandbox-vm-native": patch
---

fix(sandbox-vm-native): recreate Darwin versioned dylib shims in the private TCB dir

The vm-lane BLK feature probe failed on the physical Apple Silicon runner
with `dyld: Library not loaded: libkrun.1.dylib`, so `probe()` returned
`available:false` and all 16 L3/L4 tests skipped (fail-closed).

`verifyVmTcb` resolves the realpath of each TCB artifact before
`copyVerifiedArtifact` copies it into the engine-private dir — so the
private libkrun/libkrunfw copies carry the UNVERSIONED basenames
(`libkrun.dylib`). But the helper's dyld install name is the VERSIONED
`libkrun.1.dylib` (a symlink → `libkrun.dylib` in the artifacts dir).
`mirrorSonameLinks`, which recreates those versioned shims pointing at the
verified private copies, only matched the Linux `.so.N` pattern and was an
explicit no-op on Darwin — so the private dir never got `libkrun.1.dylib`
and the loader could not resolve the helper's dependency from the verified
copies.

Extend the shim pattern to the Darwin `.N.dylib` names
(`libkrun.1.dylib`, `libkrunfw.5.dylib`), still targeting only the private
copy's basename. Adds a platform-agnostic regression test pinning both the
Linux `.so.N` and Darwin `.N.dylib` mirroring (the existing loader test is
ELF/Linux-only and skips on macOS — the gap that let this through).
