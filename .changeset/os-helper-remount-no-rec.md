---
"@agentoctopus/sandbox": patch
---

os-helper: stop passing mount flags the kernel ignores on remount. Some distro kernels (the privileged-CI runner) carry an out-of-tree mount-flag validator that rejects MS_REMOUNT|MS_BIND combined with MS_REC (EPERM 0x5021) or with MS_NOSUID|MS_NODEV (EPERM 0x1021), killing the helper before the cgroup attach (surfaced as ESRCH). Two changes, both behavior-preserving on mainline: (1) drop the no-op MS_REC from the read-only remounts (remount_ro never recurses); (2) move MS_NOSUID|MS_NODEV off the remount and onto the initial bind, where the kernel actually honors them — a remount of an already-read-only bind ignores per-mount flag changes. The runtime root and host binds stay read-only and noexec-on-skill; no submounts exist beneath the root at remount time (the rootfs /proc is mounted after chroot).
