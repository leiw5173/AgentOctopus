---
'@agentoctopus/sandbox-vm-native': patch
---

fix(sandbox-vm-native): make build-vm-rootfs run + produce deterministic ext4 images

Four latent bugs surfaced the first time the VM rootfs build ran on the release
lane (the VM TCB chain had never built before, so these never executed):

1. **Tool gate misprobed tune2fs.** It ran `tune2fs -V` to check presence, but
   tune2fs has no -V flag (`invalid option -- 'V'`, exit 1); execFile rejects on
   ANY non-zero exit, so an INSTALLED tune2fs was misreported as "not on PATH".
   Probe by resolving the tool on PATH (executable-file check) instead — uniform
   across mke2fs/tune2fs/cc.

2. **Inode exhaustion.** `inodeCount = entries + 4` ignored that ext4 reserves
   inodes 1-10 (root is inode 2) and mke2fs takes inode 11 for lost+found, so
   the staging tree's inodes start at 12 — the formula left only `entries - 6`
   usable inodes. It succeeded only while the tree was tiny and died with
   "Could not allocate inode ... directory 'bin'" the first time a real guest
   node binary was packed. Reserve the structural inodes plus headroom:
   `inodeCount = entries + 32`.

3. **Superblock nondeterminism.** (a) `E2FSPROGS_FAKE_TIME=0` is treated as
   unset by e2fsprogs (0 is falsy), so all superblock timestamps used the real
   wall clock — FIXED_EPOCH is now '1'. (b) mke2fs randomized the 16-byte
   s_hash_seed, so two builds differed — pin it via `mke2fs -E
   hash_seed=<ROOTFS_UUID>`. (c) `tune2fs -T 0` (last-check) died with "Couldn't
   parse date/time specifier" (every timezone-independent value is rejected), so
   drop -T — the fake clock already fixes last-check at mkfs time.

4. **Per-inode atime nondeterminism.** mke2fs `-d` copies each source file's
   atime into the image inode, and the double-build reproducibility assertion
   reads the SAME staging tree twice: on CI runners without `noatime`, the first
   mke2fs read bumps each source's atime, so the second build packs a different
   atime and the digests diverge (the earlier superblock fixes only cover
   seconds-pinned fields; E2FSPROGS_FAKE_TIME does not touch source atime). Pin
   every staging entry's atime+mtime to FIXED_EPOCH (`pinStagingTimes`) before
   mke2fs packs the tree.

Verified on Ubuntu (e2fsprogs 1.47): the real recipe now completes with a real
guest node binary (inode floor holds), and two builds produce byte-identical
images (0 differing bytes) with atime pinned to the fixed epoch.
