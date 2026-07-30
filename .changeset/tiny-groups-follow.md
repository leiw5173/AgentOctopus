---
'@agentoctopus/sandbox': patch
'@agentoctopus/sandbox-vm-native': patch
---

fix(sandbox-vm-native): build helper launch spec as helper argv[1] (CR-1/CR-2)

The VM helper's argv[1] must be a base64url(JSON) helper launch spec containing rootfsPath, skillBlockPath, caBlockPath, vsockPort, vsockHostSocket, cpus, memMib, bootstrapPath, bootstrapArgv, and trustedEnv. The guest bootstrapArgv (including the CBOR blob) is nested inside this spec. Previously the engine passed the guest bootstrapArgv directly as the helper's argv, which broke the helper contract and prevented the VM from booting.

- Added `buildHelperLaunchSpec()` in `packages/sandbox-vm-native/src/helper-launch-spec.ts` with fail-closed validation (absolute paths, no `..`, no NUL, vsockPort range, bootstrapArgv length/exactly bootstrapPath).
- Wired it into `VmEngineImpl.start()` so the helper is spawned with `[helperPath, helperSpecToken]`.
- Added optional `trustedEnv?: string[]` to `VmStartConfig` in `packages/sandbox/src/vm/types.ts` for Task 2's vsock environment plumbing.
- Updated L1 fake-spawn tests to assert the new helper argv contract and decode/verify the nested spec.
