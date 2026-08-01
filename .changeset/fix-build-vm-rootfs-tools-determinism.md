---
'@agentoctopus/sandbox-vm-native': patch
---

fix(sandbox-vm-native): make build-vm-rootfs run + produce deterministic ext4 images

Two latent bugs surfaced the first time the VM rootfs build ran on the release
lane (the VM TCB chain had never built before):

1. **Tool gate misprobed tune2fs.** It ran `tune2fs -V` to check presence, but
   tune2fs has no -V flag (`invalid option -- 'V'`, exit 1); execFile rejects on
   ANY non-zero exit, so an INSTALLED tune2fs was misreported as "not on PATH".
   Probe by resolving the tool on PATH (executable-file check) instead — uniform
   across mke2fs/tune2fs/cc.

2. **The image was non-deterministic and the build then failed.** (a)
   `E2FSPROGS_FAKE_TIME=0` is treated as unset by e2fsprogs (0 is falsy), so all
   superblock timestamps used the real wall clock — FIXED_EPOCH is now '1'. (b)
   mke2fs randomized the 16-byte s_hash_seed, so two builds differed — pin it via
   `mke2fs -E hash_seed=<ROOTFS_UUID>`. (c) `tune2fs -T 0` (last-check) died with
   "Couldn't parse date/time specifier" (and every timezone-independent value is
   rejected), so drop -T — the fake clock already fixes last-check at mkfs time.

Verified on Ubuntu (e2fsprogs 1.47): two builds now produce byte-identical
images (0 differing bytes), timestamps pinned to the fixed epoch, and tune2fs
succeeds.
