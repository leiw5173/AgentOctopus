---
'@agentoctopus/sandbox-vm-native': patch
---

fix(sandbox-vm-native): pin staging dir atimes after the last read, not before (R7)

`build-vm-rootfs.mjs` pinned the staging tree's atime/mtime to the fixed epoch
*before* walking it, and — more importantly — before mke2fs read it. On hosts
without noatime, Linux relatime bumps a directory's atime to wall-clock the
moment it is readdir'd (a pinned atime ≤ mtime is exactly the relatime
trigger), so the directory atimes drifted to the build time and the sealed
rootfs was not byte-for-byte reproducible across separate runs even though the
same-run double-build passed.

Two rules now hold:

- `pinStagingTimes` walks POST-ORDER: a directory is utimes'd only after its
  children are processed, so its own readdir never comes after its utimes.
- `buildOnce` re-pins the staging tree immediately after mke2fs returns — mke2fs
  -d readdir'd the whole tree, so the pin must be the last touch before the next
  build reads it. Build 1 and build 2 (and any later cross-run build) therefore
  read identical directory atimes.
