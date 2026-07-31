---
'@agentoctopus/sandbox': patch
---

fix(sandbox): capture real uid/gid before unshare in os-helper namespace pivot

The trusted `os-helper` builds the sandbox's user-namespace uid_map/gid_map as
`"0 <real-id> 1"` (in-ns uid 0 → the real host id) so root-owned files in the
verified runtime root stay accessible after the pivot. But both the launch path
(`phase1_outside_chroot`) and the privileged-capability probe
(`probe_namespaces`) called `getuid()`/`getgid()` AFTER
`unshare(CLONE_NEWUSER|...)`. Inside the fresh user namespace, with no uid_map
written yet, `getuid()` returns the kernel overflow id (65534), so the helper
wrote `"0 65534 1"` — an invalid mapping the kernel rejects with EPERM, failing
the whole pivot at the `uid_map` write.

The bug was latent: the privileged Linux lane requires a self-hosted
`sandbox-privileged` runner that did not exist, so `os-helper` had never
actually executed on a real host. With a runner provisioned, the lane's
`security:probe-linux -- --require` step failed with
`os-helper: /proc/self/uid_map: Operation not permitted` (exit 127).

Fix: capture `ruid`/`rgid` before the `unshare` call in both functions, so the
map targets the real host id (`"0 0 1"` for a root-run helper). Verified by
compiling the helper and running `--probe-namespaces` on a privileged Ubuntu
host: exit 127 before, exit 0 after.
