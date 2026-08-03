---
"@agentoctopus/sandbox-vm-native": patch
---

fix(sandbox-vm-native): relay guest workload stdio to the host via a named "krun-stdio" console port

After the bootstrapArgv + cwd fixes, the G1/G2 qualification gates booted the
guest, decoded the launch spec, and emitted `{"ready":true}` on the
octopus-control port — but the probe's `G1-DONE`/`G2-DONE` markers never
reached the host, so the gates NO-GO'd with "DONE marker absent" even though
the guest halted cleanly (helper exit 0 in ~2s).

Root cause: our custom `octopus-vm-init` is the guest PID 1 (libkrun's own
init never runs), and at boot its fd 1 is a stray virtio-console port that
goes nowhere — so the workload's `console.log` was lost. Routing the workload
through the guest's implicit console (`/dev/console` == hvc0) and pointing
libkrun's console output at the helper's stdout with `krun_set_console_output`
still dropped every byte, whether targeted at `/dev/fd/1` or a `/dev/fd/6`
alias: `krun_start_enter` "takes over stdin/stdout" (libkrun.h) and the
implicit-console file sink never relays (verified twice: console tx events
fire in the guest, clean shutdown, empty helper stdout). Meanwhile the named
multiport port (octopus-control, real pipe fds 3/4) relays perfectly and
survives the takeover — proof of the working mechanism.

Fix — a second named port, "krun-stdio", on the SAME multiport console device
as octopus-control, wired to real pipe fds (shared by the qualification gate
AND real skill execution; no gate/engine bridging changes needed because both
already consume `raw.stdout`/`raw.stdin`):

- `vm-helper.c`: register `krun_add_console_port_inout(ctx, console_id,
  "krun-stdio", input_fd=7, output_fd=6)` alongside octopus-control, drop the
  broken `krun_set_console_output` call, fail-closed-verify fds 6/7 are open
  before registration, and bump the launch mass-close watermark to 8 (keep
  0-7). Two inout ports on one multiport device do not panic libkrun
  (verified), unlike a second console device or /dev/null-backed input.
- `vm-init.c`: `redirect_workload_stdio` now opens the "krun-stdio" port BY
  NAME (via /sys/class/virtio-ports) and dup2's it onto the workload's fd
  0/1/2 before execve — so workload output rides the port to the helper's
  stdout pipe (-> `raw.stdout` -> `vm.stdout`) and host writes to `raw.stdin`
  reach the workload's stdin.
- `native-binding.ts`: the posix_spawn file actions now also dup2 the stdout
  pipe write end onto child fd 6 (the port's output) and a new stdin-relay
  pipe read end onto child fd 7 (the port's input); `raw.stdin` is a real
  fd-backed stream to that pipe (no longer a sentinel).
- `engine.ts`: drop the now-dead `raw.stdin` override (workload stdin rides
  the krun-stdio port, not the host->guest control pipe — the control channel
  carries only ready/error frames).
- `run-vm-gates.mjs`: relabel the returned streams to name the krun-stdio
  relay (the 90s fail-closed per-boot timeout from the previous change stays).

Side benefit: removing `krun_set_console_output` restores libkrun's trace
logging to the helper's stderr (the API had been redirecting the logger).
