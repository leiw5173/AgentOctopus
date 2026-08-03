---
'@agentoctopus/sandbox-vm-native': patch
---

fix(sandbox-vm-native): consume probe-verified state at prepare/start; re-verify TCB/rootfs at boundaries

- probe() now caches the fully verified TCB + gate-manifest state per engine
  instance; resolveRootfs()/assertRootfsQualified()/start() require it and
  never re-read gate-manifest.json — a post-probe swap with a self-consistent
  but unsigned gate is invisible to prepare().
- Prepare boundary: all four TCB artifacts are re-verified (digest/symlink/
  mode) when resolveRootfs() runs, immediately before the image builder is
  consumed.
- Launch boundary: start() re-verifies helper/libkrun/libkrunfw and re-hashes
  the rootfs image against its ref + the cached gate's qualifiedRootfsDigests
  immediately before exec/krun_add_disk. A gate, helper, library, builder, or
  rootfs swapped after probe() fails closed.
