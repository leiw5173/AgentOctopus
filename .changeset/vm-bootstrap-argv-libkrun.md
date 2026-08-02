---
"@agentoctopus/sandbox": patch
"@agentoctopus/sandbox-vm-native": patch
---

fix(sandbox-vm-native): drop duplicate bootstrapPath from bootstrapArgv (libkrun argv[0] semantics)

The VM guest died at bootstrap with `launch-spec decode/validate failed` on
every real boot. Root cause (confirmed by an in-guest diagnostic): libkrun's
`krun_set_exec(exec_path, argv, ...)` uses `exec_path` as the guest's argv[0]
and **appends** the supplied `argv` array after it. The old
`bootstrapArgv = [bootstrapPath, launchSpecBlob]` therefore produced guest
`argv = [path, path, blob]`, so vm-init read the executable *path* (not the
CBOR blob) at argv[1] and failed to decode it. `bootstrapArgv` now carries
only the blob (`[launchSpecBlob]`), yielding guest `argv = [path, blob]` with
the blob at argv[1] as the bootstrap protocol expects. Validation invariants
in engine.ts, helper-launch-spec.ts, and vm-helper.c updated from
"length 2 / argv[0]===bootstrapPath" to "length 1 / argv[0]!==bootstrapPath".
