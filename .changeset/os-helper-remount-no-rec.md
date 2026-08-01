---
"@agentoctopus/sandbox": patch
---

os-helper: drop the no-op MS_REC from the read-only remount of the verified runtime root. MS_REC is meaningless for remount in the upstream kernel (remount_ro applies flags to the top mount only and never recurses), but some distro kernels carry an out-of-tree mount-flag validator that rejects the MS_REMOUNT|MS_BIND|MS_REC combination outright (EPERM on 0x5021), killing the helper before the cgroup attach (surfaced as ESRCH). Dropping MS_REC is behavior-preserving on mainline and required on such kernels: the root stays read-only and no submounts exist beneath it at that point (the rootfs /proc is mounted after chroot).
