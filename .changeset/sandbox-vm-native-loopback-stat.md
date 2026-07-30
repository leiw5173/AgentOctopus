---
'@agentoctopus/sandbox-vm-native': patch
---

fix(sandbox-vm-native): real statRootfsFile via ro loopback mount (HI-2)

- Added `packages/sandbox-vm-native/src/rootfs-loopback-mount.ts` implementing the real `statRootfsFile` seam for `assertExecutablesQualified`.
- `createLoopbackStatRootfsFile()` mounts the sealed ext4 rootfs image read-only at a per-call temp mountpoint (`mount -o loop,ro`; needs CAP_SYS_ADMIN — privileged-Linux CI lane), stats the guest path, then umounts + cleans up.
- `mountRootfsReadOnly(path)` + `umount(handle)` exported for reuse.
- Fail-closed invariant: mount/stat/umount failures THROW a descriptive `RootfsMountError` — never silently degrade to "all executables qualified". ENOENT (guest path absent) is the only condition returning null (caller rejects via `ExecutablesUnqualifiedError`).
- Resource safety: umount + rmdir run in try/finally around stat; a second try/finally around umount ensures temp-dir cleanup even on umount failure.
- Non-Linux platforms throw fail-closed (loopback mount unavailable); the production VM backend `prepare()` path runs only where CAP_SYS_ADMIN is available.
- Wired the real factory into `VmEngineImpl.assertExecutablesQualified` (engine.ts), replacing the previous always-null stub.
- New Linux-lane tests (skipIf-gated to Linux + mke2fs) build a tiny ext4 fixture and assert pass/fail of `assertExecutablesQualified` against the real loopback mount. Existing injectable-seam unit tests unchanged.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
