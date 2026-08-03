---
'@agentoctopus/sandbox-vm-native': patch
---

Wire the VM gate's helper spawn through the engine's fd plumbing so G1/G2 capture the guest console.

`run-vm-gates.mjs` booted the qualification VM with a plain `execFile`, leaving the helper's required control fds (3 = host→guest, 4 = guest→host console, 5 = rootfs `/dev/fd/5`) as inherited handles to `/dev/null`. The helper booted, relayed the guest probe's `G1-DONE`/`G2-DONE` console output to a dead fd, opened the wrong rootfs inode, and exited 0 with empty captured stdout — a NO-GO "helper early-exit, no output" that looked like a dyld/codesign kill but was actually the gate reading the wrong channel.

The gate now spawns via `createNativeDeps().spawn` with the same file_actions the engine installs (dup2 temp→3/4/5), reads the guest console from fd 4, and falls back to the helper's own stdout/stderr + exit status when the console stays empty. `native-binding.ts` exports `fdToReadable`/`fdToWritable` for this (not added to the leaf public surface in `index.ts`).
