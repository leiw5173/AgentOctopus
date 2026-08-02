---
"@agentoctopus/sandbox-vm-native": patch
---

fix(sandbox-vm-native): relay guest workload stdio to the host via a krun default console

After the bootstrapArgv + cwd fixes, the G1/G2 qualification gates booted the
guest, decoded the launch spec, and emitted `{"ready":true}` — but the probe's
`G1-DONE`/`G2-DONE` markers never reached the host, so the gates NO-GO'd with
"helper early-exit: DONE marker absent" and the vCPU halted with exit 0.

Root cause: the helper registered ONLY the `octopus-control` multiport console
(fds 3/4) and never called `krun_add_virtio_console_default`, so no
`krun-stdin`/`krun-stdout`/`krun-stderr` ports existed. libkrun's own guest
init (which would redirect the app's stdio to those ports) never runs — our
custom `octopus-vm-init` is PID 1 — so the workload's fd 1/2 went to the boot
console and were lost.

Fix (two parts, shared helper binary so it covers both the qualification gate
AND real skill execution):
- `vm-helper.c`: register three named inout ports — `krun-stdin`/`krun-stdout`/
  `krun-stderr` — on the SAME multiport console as `octopus-control`, relayed to
  the helper's own fd 0/1/2 (/dev/null backs each port's unused direction).
  NOTE: `krun_add_virtio_console_default` is deliberately NOT used — it adds a
  second console device whose ports make libkrun panic at
  `devices/src/virtio/console/device.rs:263` ("port rx queue should exist",
  helper SIGABRT 134) the instant the guest opens them.
- `vm-init.c`: before execve, dup2 the `krun-stdout`/`krun-stderr`/`krun-stdin`
  ports onto fd 1/2/0 (`redirect_workload_stdio`), generalizing the port-by-name
  scan into `open_named_port`.
- `run-vm-gates.mjs`: the gate now returns the helper's own stdout/stderr (where
  the workload output lands) alongside the control-port ready/error frame, so
  the evaluators see the markers and a NO-GO still surfaces the bootstrap reason.
