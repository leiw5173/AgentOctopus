---
"@agentoctopus/sandbox-vm-native": patch
---

fix(sandbox-vm-native): make VM guest workloads bootable — bundle node's loader/libc into the sealed rootfs + propagate workload exit codes

The vm-lane G1/G2 qualification gates could never reach GO: guest-side
diagnostics proved the launch-spec decode, the krun-stdio stdio relay, and
the execve inputs were all correct, yet the guest halted within ~1ms of the
execve. Two root causes:

1. **Loaderless rootfs.** The sealed rootfs shipped the dynamically-linked
   nodejs.org `node` binary with NO ELF interpreter and NO libc — the guest
   kernel's execve of `/usr/bin/node` failed ENOENT (missing PT_INTERP), so
   no workload could ever run. `build-vm-rootfs.mjs` now discovers the node
   binary's interpreter + transitive `DT_NEEDED` closure via `readelf` and
   copies them into `/lib` (and the interpreter to its baked-in absolute
   path, `/lib/ld-linux-aarch64.so.1` or `/lib64/ld-linux-x86-64.so.2`) from
   the per-guest-arch library dirs CI provides (`OCTOPUS_ROOTFS_LIBS` for x64,
   `OCTOPUS_ROOTFS_LIBS_ARM64` for arm64 — the host multiarch dir and the
   aarch64 cross-toolchain dir). A dynamic node with no libs dir fails the
   build rather than shipping a loaderless rootfs. The workflow adds
   `libstdc++6-arm64-cross` (arm64 libstdc++.so.6) and exports both dirs.
   Guest vm-init/vsock-forwarder stay static (TCB-critical, independent of
   the node library set).

2. **Lost exit codes.** libkrun's exit-code propagation is a virtiofs-only
   ioctl that no-ops on this sealed ext4 root, so the helper process always
   exited 0 regardless of workload status. `octopus-vm-init` now FORKS the
   workload, waitpid()s the child, and reports `{"exit":N}` (WEXITSTATUS, or
   128+WTERMSIG when signaled) over the octopus-control port; the engine
   treats that frame as authoritative over the helper's exit code (bounded
   settle wait so the frame is never dropped to a pipe-delivery race). The
   control fd is FD_CLOEXEC'd — not closed — across the execve, so execve
   failures now report `{"error":"execve failed: <errno>"}` (previously
   silenced by the pre-execve close) while the workload itself can never
   write a control frame.

Also removes the temporary guest-side stdio diagnostics that proved the
relay (diag frames, pre-exec sleep discriminator).
