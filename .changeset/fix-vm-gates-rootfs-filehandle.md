---
"@agentoctopus/sandbox-vm-native": patch
---

Fix a FileHandle lifecycle bug in run-vm-gates.mjs that aborted the G1 gate on the first real physical-runner VM boot. `openRootfsReadOnly` returned only the raw fd from `fs.open()`, dropping the FileHandle; modern Node treats a GC-collected FileHandle as an error and closed fd 17 (rootfs.img) out from under the parent's independent raw-fd management ("A FileHandle object was closed during garbage collection"). The function now returns the FileHandle, the caller owns it, and both cleanup paths close it explicitly via a new `closeHandle`. The bug was latent until vm-lane ran on bare-metal Apple Silicon — on hosted macos-15 the lane always skipped before reaching G1.
