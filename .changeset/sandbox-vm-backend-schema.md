---
"@agentoctopus/sandbox": minor
---

Add `vm` config block (rootfs, memMib, cpus, kernelCmdline, libkrunAbi pinned to v1.19.4), `vmRuntime` field on runtime profiles (with required `executables` map), and `'vm'` to the `BackendKind` union + `defaultBackend` enum to register the VM (libkrun) sandbox backend in config.
