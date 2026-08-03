---
"@agentoctopus/sandbox": patch
---

os-helper: drop the untrusted process to the MAPPED root id (in-ns 0 → host ruid), not uid/gid 65534 — and keep the single-line uid/gid self-map. Root cause of the privileged-lane credential-drop cascade:

After `unshare(CLONE_NEWUSER)` the helper's credentials live in the NEW (child) user namespace, and the kernel's `cap_capable()` level check refuses to look up `CAP_SETUID`/`CAP_SETGID` in an ANCESTOR namespace from a descendant (`ns->level <= cred->user_ns->level` → EPERM). So a MULTI-line uid_map/gid_map (which skips the unprivileged single-extent self-map exemption and falls to the privileged `ns_capable(ns->parent,…)` path) EPERMs no matter how much privilege the helper holds — the helper cannot write its own two-line map from inside the child namespace. Only the single-extent identity self-map `"0 rid 1"` is writable (the kernel's `nr_extents==1` exemption). Consequently the untrusted target 65534 is NOT mappable, and `setuid/setgid(65534)` would EINVAL.

Resolution: keep the single-line self-map (unmappable 65534 is never written) and have phase 3 drop to the MAPPED root id 0. This is still full isolation: in-ns "root" maps to the UNPRIVILEGED host ruid, and the process remains confined by `NO_NEW_PRIVS` + chroot + the named netns + cgroup — "root" here has no host privilege. Mapping 65534 would require a privileged PARENT-namespace writer for `/proc/<pid>/uid_map`, which this self-contained helper does not have.

Also dropped the phase-3 `setgroups(0, NULL)` call: phase-1's mandatory `setgroups` "deny" (required for the gid self-map) irreversibly disables `setgroups(2)` in the namespace, and the call is a no-op anyway (the runner runs with no supplementary groups — `Groups:` empty). This reverts the two earlier incorrect attempts (a root-only "deny" skip that broke gid_map, and a two-line overflow map that EPERMs).
