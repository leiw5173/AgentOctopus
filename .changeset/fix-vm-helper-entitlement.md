---
'@agentoctopus/sandbox-vm-native': patch
---

Drop the unnecessary `com.apple.vm.networking` entitlement from the Darwin helper's ad-hoc codesign — it made the kernel SIGKILL the helper at exec.

The VM helper runs the guest with vsock-ONLY networking (TSI disabled — `vm-helper.c` adds no virtio-net/passt/gvproxy), so it needs only `com.apple.security.hypervisor`. Requesting `com.apple.vm.networking` (bridged/vmnet networking the helper never uses) on an ad-hoc signature causes macOS 15+ (verified on macOS 26 and the `macos-15` lane) to SIGKILL the process at exec with exit 137 and zero userspace output — the exact G1/G2 and `--has-blk` kill observed on the vm-lane. Signing with only the hypervisor entitlement runs cleanly.
