---
"@agentoctopus/sandbox-vm-native": patch
---

fix(sandbox-vm-native): relay guest workload stdio to the host via a console-output fd alias

After the bootstrapArgv + cwd fixes, the G1/G2 qualification gates booted the
guest, decoded the launch spec, and emitted `{"ready":true}` — but the probe's
`G1-DONE`/`G2-DONE` markers never reached the host, so the gates NO-GO'd with
"helper early-exit: DONE marker absent" even though the guest halted cleanly
(helper exit 0).

Root cause: our custom `octopus-vm-init` is the guest PID 1 (libkrun's own init
never runs), and at boot its fd 1 is a stray virtio-console port that goes
nowhere — so the workload's `console.log` was lost. Routing the workload through
the guest's implicit console (`/dev/console` == hvc0) and pointing libkrun's
console output at the helper's stdout with `krun_set_console_output("/dev/fd/1")`
still dropped every byte: `krun_start_enter` "takes over stdin/stdout" (per
libkrun.h), so a console sink on fd 1 resolves back into the VMM's own console
bridge and is swallowed (verified: empty helper stdout, no logger output).

Fix (shared helper binary, so it covers both the qualification gate AND real
skill execution; no gate/engine bridging changes needed because fd 6 aliases the
stdout pipe both already read):
- `native-binding.ts`: the posix_spawn file actions now alias the stdout-pipe
  write end onto a second child fd, `CONSOLE_OUT_FD` (6), alongside fd 1/2. fd 6
  is untouched by libkrun's stdin/stdout takeover, so it is a safe console sink.
- `vm-helper.c`: call `krun_set_console_output(ctx, "/dev/fd/6")` so libkrun
  writes the implicit console's output RAW to the stdout pipe (-> the host's
  `raw.stdout` -> `vm.stdout`), and bump the launch mass-close watermark to keep
  fd 6 alive (`FD_LOW_WATERMARK_LAUNCH` = 7).
- `vm-init.c`: before execve, dup2 `/dev/console` onto fd 0/1/2
  (`redirect_workload_stdio`) so the workload's stdio rides the implicit console
  to the host.
- `run-vm-gates.mjs`: the gate returns the guest control frame plus the helper's
  stdout and stderr, each LABELED (so a NO-GO is diagnosable and the CI log shows
  which stream the markers rode), and gained a fail-closed per-boot timeout (90s)
  so a guest that never halts yields a diagnosable TIMEOUT instead of hanging the
  lane.
