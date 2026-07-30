---
'@agentoctopus/sandbox': patch
'@agentoctopus/sandbox-vm-native': patch
---

Implement the per-session vsock host bridge and trustedEnv plumbing.

- Adds `VsockBridge` to `packages/sandbox/src/vm/vsock-bridge.ts`: a per-session unix-domain socket listener under the 0700 workDir that forwards guest vsock connections to the in-process egress proxy's loopback address.
- Wires the bridge into `VmSandboxBackend` so that `prepare()` assigns a deterministic non-zero `vsockPort` and absolute `vsockHostSocket`, and `spawn()` passes them via `trustedEnv` so the guest bootstrap can read `OCTOPUS_VSOCK_PORT`/`OCTOPUS_VSOCK_HOST_SOCKET` through `krun_set_exec`.
- `VmSandboxBackend.cleanup()` stops the bridge as a soft teardown step.
- Adds unit tests for `VsockBridge` (unix-socket forwarding with a stub proxy) and `VmSandboxBackend` (prepare assigns vsock values, spawn passes `trustedEnv`).
