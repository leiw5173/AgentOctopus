---
"@agentoctopus/sandbox-vm-native": patch
---

Pre-create the guest mount points in the sealed rootfs so the read-only root can boot. The rootfs is mounted `ro` (by design — an immutable sealed image), so neither libkrun's `init_or_kernel` nor the guest `vm-init` can mkdir at runtime; the G1 gate failed on the first physical-runner boot with "Error creating directory (/proc) / Couldn't mount filesystems, bailing out". The staging skeleton now also creates `/proc` (procfs for libkrun init), `/sys` (vm-init scans /sys/class/virtio-ports), `/skill` (vm-init mounts /dev/vdb), and `/etc/skill-ca` (vm-init mounts /dev/vdc), matching the documented "mount points must pre-exist in the rootfs" intent. Changes the rootfs tree, so the producer emits a new sealed digest on the next build.
