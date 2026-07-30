---
'@agentoctopus/sandbox-vm-native': minor
'@agentoctopus/core': minor
'@agentoctopus/sandbox': patch
---

feat(sandbox-vm-native): native VmEngineDeps binding + production constructor wiring (CR-5)

- Added `koffi`-based `createNativeDeps()` FFI binding in `packages/sandbox-vm-native/src/native-binding.ts`.
- Implements `pipe()` (Linux `pipe2(O_CLOEXEC)` / Darwin `pipe()+__fcntl(F_SETFD,FD_CLOEXEC)`), `dupFdCloexec()` (`F_DUPFD_CLOEXEC`), and `spawn()` (`posix_spawn` + file actions + Darwin `POSIX_SPAWN_CLOEXEC_DEFAULT`).
- `spawn()` creates real stdout/stderr pipes with `adddup2` file actions; controlRead/stdin are overridden by the engine with fd-backed streams (Approach A) via `__octopusNeedsEngineOverride` sentinel marker.
- `waitpid` ECHILD (rc<0) treated as child-already-reaped (resolve, not reject).
- NUL-byte rejection in argv/envp (koffi silently truncates at NUL).
- Wires `createVmBackend()` to construct `VmEngineImpl(engineOpts, createNativeDeps())` and `VmImageBuilderImpl(builderBinaryPath)`.
- Extends `sandbox.vm` schema with optional artifact-path fields defaulting to `prebuilds/<platform>/`.
- Fail-closed existence check on helperPath/builderBinaryPath in assembly.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
