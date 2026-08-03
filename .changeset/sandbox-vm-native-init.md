---
"@agentoctopus/sandbox-vm-native": minor
---

Create the sandbox-vm-native package with assertExecutablesQualified: R9/R10 executable-qualification logic (cheap uncached keys==bins set-equality check + cached rootfs stat-walk enforcing regular-file + exec-bit + no-symlink + not-under-mount-override).
