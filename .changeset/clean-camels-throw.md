---
'@agentoctopus/sandbox-vm-native': minor
'@agentoctopus/core': minor
'@agentoctopus/sandbox': patch
---

feat(sandbox-vm-native): native VmEngineDeps binding + production constructor wiring (CR-5)

- Added `koffi`-based `createNativeDeps()` FFI binding in `packages/sandbox-vm-native/src/native-binding.ts`.
- Implements `pipe()` (Linux `pipe2(O_CLOEXEC)` / Darwin `pipe()+fcntl`), `dupFdCloexec()` (`F_DUPFD_CLOEXEC`), and `spawn()` (`posix_spawn` + file actions + Darwin `POSIX_SPAWN_CLOEXEC_DEFAULT`).
- Wires `createVmBackend()` to construct `VmEngineImpl(engineOpts, createNativeDeps())` and `VmImageBuilderImpl(builderBinaryPath)`.
- Extends `sandbox.vm` schema with optional artifact-path fields defaulting to `prebuilds/<platform>/`.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
