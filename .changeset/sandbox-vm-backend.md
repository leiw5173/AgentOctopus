---
"@agentoctopus/sandbox": minor
"@agentoctopus/sandbox-vm-native": minor
"@agentoctopus/core": minor
---

Add a lightweight VM sandbox backend (libkrun v1.19.4 + Hypervisor.framework)
for `full` isolation without Docker Desktop dependency. Skills run inside a
Linux VM with the snapshot exposed as a read-only ext4 block image (NOT
virtiofs — libkrun treats guest and VMM as the same host security context),
built by a deterministic cross-platform image-builder (no system mkfs.ext4 /
Docker / Homebrew dependency for skill block images; the rootfs uses standard
`mke2fs` since it must carry a real ~30 MiB node binary that exceeds the C
writer's single-block-group capacity) with descriptor-relative traversal
(openat + fstat on the fd, O_NOFOLLOW, explicit "."/".." rejection — no
lstat→open swap race) and a TOCTOU-closing digest re-compute. The
image-builder port exposes two methods: buildSnapshotImage (directory +
canonical snapshot digest) and buildSingleFileImage (single file + file
digest, for the CA bundle).

libkrun runs in a dedicated signed+entitled helper subprocess
(krun_start_enter terminates its caller) using the real v1.19.4 API
(krun_set_vm_config(ctx, num_vcpus, ram_mib) — vCPUs before RAM, per the
verified header signature + krun_disable_implicit_vsock +
krun_add_vsock(tsi_features=0) + krun_add_vsock_port + krun_add_disk for
block ids vda/vdb/vdc + krun_set_root_disk_remount("/dev/vda","ext4","ro")
+ krun_set_exec of a TRUSTED bootstrap /usr/libexec/octopus-vm-init +
krun_set_workdir(ctx, "/") — workdir pinned to "/", NOT the workload cwd,
because /skill is not mounted until the bootstrap runs). The trusted
bootstrap (PID 1) mounts /dev/vdb→/skill and /dev/vdc→/etc/skill-ca
read-only, mounts tmpfs /tmp + /run, starts the loopback↔vsock forwarder,
emits a ready handshake, then execve's the original workload.

The workload executable/argv/env travel as a base64url(canonical-CBOR)
LaunchSpec blob in bootstrapArgv[1] (single channel — raw CBOR cannot ride
argv since argv is NUL-terminated; not a block artifact, not over the
control channel); dual size caps (decoded 65536 / argv token 98304)
enforced before start; NUL bytes rejected in every string; malformed spec
⇒ bootstrap exits 127 without execve (fail-closed). The control channel
is a named virtio-console port ("octopus-control") registered via
krun_add_virtio_console_multiport + krun_add_console_port_inout (NOT an
inherited host fd — host fds do not cross the VMM boundary); it carries
ONLY ready/error frames (NO exit frame — once execve replaces PID 1 no
bootstrap process remains); workload exit status is the helper subprocess
exit status caused by krun_start_enter (function only returns on pre-start
error; otherwise exit()s the helper with the guest exit code).

Implicit TSI is explicitly disabled (and BLK feature verified) so the sole
network egress is a vsock-bridged in-process egress proxy (credentials
never enter the VM). The leaf-package boundary is closed by defining
VmEnginePort + VmImageBuilderPort in packages/sandbox and injecting both
via DI; packages/sandbox imports nothing from the native package — not
even `import type`. probe() is parameterless (verifies TCB artifacts + BLK
+ hypervisor + gate-manifest signature + outer release manifest); the
selected rootfs is qualified in prepare() via resolveRootfs +
assertRootfsQualified.

Two qualification gates (host-file-unreachable, network-canary-unreachable)
run at CI/release time and bind a (platform × artifact-digest) gate
manifest — including imageBuilder + qualifiedRootfsDigests[] +
manifestDigest (self-hash over body excluding the digest field) — signed
by an outer release manifest (Ed25519, compiled-in public key). Runtime
probe verifies the manifest+signature; prepare asserts the selected rootfs
is qualified before claiming `full`. libkrun v1.19.4 is built from pinned
source (the upstream release ships no binary assets); libkrunfw v5.5.0
uses the upstream prebuilt tarballs. L3 (7) + L4 (9) escape-matrix tests
are skipIf-gated on `OCTOPUS_VM_LANE=1` + `probe()` and run on the `vm-lane`
CI job in `sandbox-security.yml`. Available on macOS Apple Silicon; Linux
x64 requires a privileged /dev/kvm CI lane or is marked unsupported
(fail-closed).
