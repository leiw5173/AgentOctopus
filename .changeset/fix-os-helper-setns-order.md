---
'@agentoctopus/sandbox': patch
---

fix(sandbox): setns into the named netns BEFORE the CLONE_NEWUSER pivot in os-helper

`os-helper` phase 1 called `unshare(CLONE_NEWUSER|...)` and only THEN
`setns(netnsFd, CLONE_NEWNET)`. `setns()` into a pre-existing network namespace
requires `CAP_SYS_ADMIN` in the CURRENT (root) user namespace — which the
`CLONE_NEWUSER` unshare immediately drops (the process becomes root only of the
fresh userns, which does not own the named netns). The helper therefore died with
`setns(netnsFd, CLONE_NEWNET): Operation not permitted`, the spawn-time cgroup
attach then hit `ESRCH`, and every privileged-linux spawn test failed.

Join the named netns before the user-namespace pivot. `setns` changes only the
network namespace, so the subsequent `unshare(CLONE_NEWUSER|CLONE_NEWNS|CLONE_NEWPID|...)`
creates the mount/pid/ipc/uts/user namespaces fresh while leaving the just-joined
net namespace in place — the sandbox keeps the named netns through the pivot.
