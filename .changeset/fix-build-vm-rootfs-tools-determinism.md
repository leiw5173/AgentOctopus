---
'@agentoctopus/sandbox-vm-native': patch
---

fix(sandbox-vm-native): make build-vm-rootfs produce deterministic ext4 images

Several latent bugs surfaced the first time the VM rootfs build ran on the
release lane (the VM TCB chain had never built before, so these never
executed). The headline fix is true byte-reproducibility; earlier attempts
only pinned SOME timestamps, so the double-build assertion flaked.

1. **Tool gate misprobed tune2fs.** It ran `tune2fs -V` to check presence, but
   tune2fs has no -V flag (exit 1); execFile rejects on ANY non-zero exit, so
   an INSTALLED tune2fs was misreported as "not on PATH". Probe by resolving
   the tool on PATH instead — uniform across mke2fs/debugfs/cc.

2. **Inode exhaustion.** `inodeCount = entries + 4` ignored that ext4 reserves
   inodes 1-10 (root=2) and mke2fs takes inode 11 for lost+found, so the tree's
   inodes start at 12 — leaving only `entries - 6` usable. It died with "Could
   not allocate inode" once a real guest node binary was packed. Now
   `entries + 32`.

3. **Byte-level nondeterminism (the real fix).** The double-build reproducibility
   assertion kept diverging because earlier fixes only pinned a subset of
   timestamps. The complete mechanism, verified on ext4/relatime with a real
   124MB node binary:
   - `E2FSPROGS_FAKE_TIME=1` (not `0` — 0 is falsy/unset) fakes the
     mkfs-assigned times: superblock created/last-check and inode crtime.
   - `mke2fs -E hash_seed=<uuid>` pins the 16-byte s_hash_seed.
   - The staging tree's atime+mtime are pinned to the epoch (`pinStagingTimes`)
     so mke2fs `-d` copies stable atime/mtime into each inode.
   - **Drop tune2fs entirely**: it unconditionally re-bumps the superblock
     `s_wtime` to the wall clock even under E2FSPROGS_FAKE_TIME, and mke2fs
     already sets mount count 0 + the pinned UUID — so tune2fs was pure
     nondeterminism.
   - **debugfs-zap every inode's ctime**: ctime is the inode-metadata-change
     time — mke2fs always sets it to the wall clock and no `touch` can pin it.
     Sweep `set_inode_field <N> ctime <epoch>` over all inodes post-build.

   Verified: two (and three) builds produce byte-identical SHA-256 images with
   a clean superblock (UUID pinned, mount count 0, wtime=epoch1).
