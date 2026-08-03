---
"@agentoctopus/sandbox-vm-native": patch
---

Fail-closed VM backend hardening (HI-4/HI-5/LO-1):

- `waitForReady` now kills the handshake after more than two malformed non-JSON control frames instead of silently dropping them.
- `probe()` no longer hard-codes `blkFeature: 'present'`; it invokes the helper's new `--has-blk` subcommand to check `KRUN_FEATURE_BLK` at runtime and fails closed if BLK support is absent or unprobeable.
- `resolveRootfs()` now streams the rootfs through `createReadStream` + `createHash` instead of reading the entire image into memory before hashing.
