---
"@agentoctopus/sandbox-vm-native": patch
---

fix(sandbox-vm-native): relay guest workload stdio to the host via the implicit console

After the bootstrapArgv + cwd fixes, the G1/G2 qualification gates booted the
guest, decoded the launch spec, and emitted `{"ready":true}` — but the probe's
`G1-DONE`/`G2-DONE` markers never reached the host, so the gates NO-GO'd with
"helper early-exit: DONE marker absent" and the vCPU halted with exit 0.

Root cause: our custom `octopus-vm-init` is the guest PID 1 (libkrun's own init
never runs), and at boot its fd 1 is a stray virtio-console port (e.g.
`/dev/vport2p2`) that goes nowhere — so the workload's `console.log` was lost.
In-guest diagnostics proved that a write to the guest's implicit console
(`/dev/console` == hvc0) DOES reach the host, but by default libkrun re-emits it
through its own logger (mangled with an `ERROR init_or_kernel` prefix on the
helper's stderr), which would corrupt real skill output.

Fix (two parts, shared helper binary so it covers both the qualification gate
AND real skill execution):
- `vm-helper.c`: call `krun_set_console_output(ctx, "/dev/fd/1")` so libkrun
  writes the implicit console's output RAW to the helper's own stdout (fd 1),
  not through its logger. `/dev/fd/1` survives `mass_close_fds` (stdio fds 0-2
  are preserved). This API is a NOOP if the implicit console is disabled; we
  never disable it. NOTE: the rejected alternatives are load-bearing to avoid —
  registering a console port on fd 0/1 is never relayed (`krun_start_enter`
  takes over the helper's stdio), and `krun_add_virtio_console_default` (a 2nd
  console device), a `/dev/null`-backed input, or a 2nd data port all panic
  libkrun at `devices/src/virtio/console/device.rs:263` ("port rx queue should
  exist", helper SIGABRT 134).
- `vm-init.c`: before execve, dup2 `/dev/console` onto fd 0/1/2
  (`redirect_workload_stdio`) so the workload's stdio rides the implicit console
  to the host's helper stdout.
- `run-vm-gates.mjs`: the gate now returns the guest control frame plus the
  helper's stdout and stderr, each LABELED, so the evaluators see the markers,
  a NO-GO still surfaces the bootstrap reason / helper exit status, and the CI
  log reveals which stream the markers rode (stdout == clean relay).
