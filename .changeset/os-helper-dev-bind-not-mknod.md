---
"@agentoctopus/sandbox": patch
---

os-helper: bind-mount host device nodes instead of mknod() for the private /dev. The privileged-CI runner's kernel hardening denies mknod() inside an unprivileged user namespace outright (EPERM) even when the caller is root-in-userns with CAP_MKNOD, the target is a fresh tmpfs mounted WITHOUT MS_NODEV, and no device cgroup is attached — killing the helper before the cgroup attach (surfaced as ESRCH). Bind-mounting the host's EXISTING /dev/{null,zero,full,random,urandom} nodes onto placeholder files in the private tmpfs needs no CAP_MKNOD and is not subject to that restriction (the same technique bubblewrap uses). The sandbox still exposes exactly those five devices, read-write; the private /dev tmpfs superblock still carries nosuid.
