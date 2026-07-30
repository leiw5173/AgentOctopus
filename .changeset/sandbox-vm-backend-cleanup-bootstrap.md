---
"@agentoctopus/sandbox": patch
---

VM backend cleanup + bootstrap verification (ME-2/LO-3):

- `cleanup()` now removes the backend-owned `workDir` (sealed `skill.img` + `ca.img` block images) as a SOFT teardown step, mirroring `OsSandboxBackend`. A workDir-rm failure is a soft diagnostic reason, never promoted to a `ContainmentCleanupError`.
- The guest bootstrap PID 1 (`/usr/libexec/octopus-vm-init`, exec'd by the helper at `spawn()`) is now verified fail-closed in `prepare()` via a second `assertExecutablesQualified` call with a synthesized single-entry map + matching bins, preserving the set-equality contract and reusing the full rootfs stat-walk.
