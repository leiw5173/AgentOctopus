---
'@agentoctopus/sandbox-vm-native': patch
---

Fix Linux CI failures in sandbox-vm-native (Code Audit unit-test job):

- **native-binding (real bug, glibc):** the koffi struct declarations for
  `posix_spawn_file_actions_*` / `posix_spawnattr_*` used `_Out_` on `_init`
  and plain `_In_` on `_adddup2`/`_addclose`/`_setflags`. koffi store-and-
  forwards struct bytes per call — `_Out_` copies out to a fresh buffer and
  `_In_` discards it — so the adddup2 mutation never reached the final
  `posix_spawn`. Invisible on macOS (its file_actions_t is a heap pointer),
  fatal on glibc (file_actions_t is INLINE struct bytes): the child's dup2
  silently dropped, `spawn bridges real stdout` got empty stdout. Every
  mutating call is now `_Inout_` so state round-trips through the object.
  Verified end-to-end on Linux amd64 (the spawn marker reaches the pipe) and
  macOS (no regression).
- **executables-qualified (env gate):** the loopback-mount suite gated on
  Linux + mke2fs presence only. `mount -o loop` also needs CAP_SYS_ADMIN + a
  loop device — absent on unprivileged ubuntu-latest and even rootful Docker.
  Now probes the real capability (build + loop-mount + unmount a tiny ext4)
  in beforeAll; the suite runs only when the probe succeeds.
- **tcb-manifest (cross-platform fixture):** fixtures hardcoded
  `libkrun.dylib`/`libkrunfw.dylib`; verifyVmTcb resolves `.so` on Linux, so
  the fixture lookup ENOENT'd on every non-macOS host. Platform-conditional
  LIBKRUN/LIBKRUNFW constants (mirrors the vm-helper-build fix in
  @agentoctopus/sandbox).
- **fd-ceiling (env gate):** the C regression test unconditionally invokes
  `cc`. Gates on a `cc --version` probe so hosts without a C toolchain (e.g.
  node:slim) skip instead of failing the compile.
