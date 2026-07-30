---
"@agentoctopus/sandbox-vm-native": minor
---

Add VmEngineImpl with posix_spawn FD plumbing (R9/R10) and createCloexecPipe seam. VmEngineImpl.start() builds the two-cloexec-pipe FD config, F_DUPFD_CLOEXEC temp slots, and adddup2 into fd3/fd4 (source≠target real dup2), with a ready-handshake protocol on the g2hRead control stream and failure paths for error-frame / helper-exit-before-ready / timeout.

Add the VM TCB producer scripts: `build-vm-rootfs.mjs` builds the sealed read-only ext4 guest rootfs with standard `mke2fs` (e2fsprogs) — fixed UUID/timestamps/inode params, journal + lazy-init disabled, double-build SHA-256 reproducibility assertion — producing `prebuilds/linux-arm64/rootfs.img` and `prebuilds/linux-x64/rootfs.img`. `vendor-libkrun.mjs` vendors libkrun v1.19.4 (built from pinned source, since the upstream release ships no binary assets) and libkrunfw v5.5.0 (upstream prebuilt tarballs, checksum-verified), writes per-artifact TCB manifests, and runs a link + runtime smoke test. Adds `security:build-vm` and `security:probe-vm` package scripts.

Add `run-vm-gates.mjs` (G1 host-file-unreachable + G2 network-canary-unreachable qualification gates; emits `gate-manifest.json` with `qualifiedRootfsDigests[]` from both arch rootfs manifests, artifact refs from per-artifact manifests, and `manifestDigest` via `computeManifestDigest`) and `sign-release-manifest.mjs` (Ed25519 detached signature over canonical gate-manifest JSON; private key from CI secret `OCTOPUS_VM_RELEASE_PRIVATE_KEY`, `--bootstrap` for first-run keypair generation, `--print-public` to derive the public key constant for `release-key.ts`; self-verifies before writing `outer-release-manifest.json`).
