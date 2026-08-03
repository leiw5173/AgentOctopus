---
"@agentoctopus/sandbox-vm-native": patch
---

Fix a circular SONAME symlink in `vendor-libkrun.mjs` `linkVersionedSonames`. On Darwin the libkrunfw layout is `libkrunfw.5.dylib` (real file) + `libkrunfw.dylib → libkrunfw.5.dylib` (symlink). `linkVersionedSonames` received the `libkrunfw.dylib` symlink, resolved its install_name to `libkrunfw.5.dylib`, then `rm`'d the real versioned file and symlinked `libkrunfw.5.dylib → libkrunfw.dylib` — producing `libkrunfw.5.dylib ↔ libkrunfw.dylib`, a cycle that destroyed the real bytes and broke `-lkrunfw` at link time (`ld: library 'krunfw' not found` on the macOS vm-lane). The function now skips a lib whose symlink target already IS the resolved versioned name (the shim relationship is already correct), leaving the digest-verified real file intact.
