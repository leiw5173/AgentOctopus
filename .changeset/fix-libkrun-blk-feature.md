---
'@agentoctopus/sandbox-vm-native': patch
---

fix(sandbox-vm-native): build libkrun with the blk feature (BLK=1)

vm-helper.c calls `krun_add_disk` and `krun_set_root_disk_remount` — libkrun's
block-device ABI, exported ONLY when libkrun is built with the `blk` cargo
feature. The vendored build ran a plain `make` (no feature flags), and `blk` is
NOT a default feature, so the produced libkrun.so omitted those symbols and the
build-vm-helper link failed:
`undefined reference to 'krun_add_disk'` / `'krun_set_root_disk_remount'`.

libkrun's Makefile maps `BLK=1` → `--features blk` (`ifeq ($(BLK),1)`). Pass it
so the TCB carries the ABI the engine requires (`blkFeatureRequired`). virtio-blk
is pure Rust, so no extra system libraries are needed. The other 12 krun_*
symbols vm-helper uses (vsock/console/exec/config) resolve in the default build,
so blk is the only feature flag required.
