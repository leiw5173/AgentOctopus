---
'@agentoctopus/sandbox-vm-native': patch
---

fix(sandbox-vm-native): return the full manifest from writeArtifactManifest

`writeArtifactManifest` returned a flat `{sha256,size,mode}` record, but its
callers log `fwManifest.artifact.sha256` / `krunManifest.artifact.size`,
expecting the nested manifest shape — so vendoring crashed with
`Cannot read properties of undefined (reading 'sha256')` immediately after the
libkrunfw extraction succeeded. Return the full manifest object (which carries
`.artifact`), matching the callers and `build-vm-rootfs.mjs`'s existing
`return manifest` convention.
