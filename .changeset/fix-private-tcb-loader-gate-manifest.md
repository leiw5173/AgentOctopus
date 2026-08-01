---
"@agentoctopus/sandbox-vm-native": patch
---

Fix `private-tcb-loader.test.ts` failing with `available:false` on the Linux CI lane. The test mocked `GateManifestSchema.parse` / `verifyGateManifest` but never wrote `gate-manifest.json` to disk; `VmEngineImpl.probe()` `readFile()`s the gate manifest from the filesystem before passing the parsed body to the (mocked) schema, so the probe died with `ENOENT → available:false, gateManifest:'missing'`. The test now writes the constructed gate body to `gate-manifest.json` so the probe's disk read succeeds. Verified passing in a Linux container with a real C toolchain.
