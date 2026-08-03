---
"@agentoctopus/sandbox-vm-native": patch
---

Cross-compile the guest binaries (`octopus-vm-init`, `octopus-vsock-forwarder`) statically for the correct target arch. They were built with the host `cc`, so on the x64 producer they became x86-64 dynamically-linked binaries regardless of target arch — the linux-arm64 guest kernel cannot exec them ("Couldn't execute '/usr/libexec/octopus-vm-init' inside the vm: No such file or directory": wrong ISA, and the sealed rootfs has no dynamic loader). `arch` is now threaded through buildArch → buildStaging → compileGuest, selecting `aarch64-linux-gnu-gcc` for arm64 and host `cc` for x64, always with `-static`. Changes the rootfs tree, so the producer emits a new sealed digest on the next build. Latent until vm-lane ran on physical Apple Silicon — the x64 guest's vm-init was correct by accident.
