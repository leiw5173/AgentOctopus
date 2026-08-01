---
"@agentoctopus/sandbox": patch
---

linux-topology lane: fix the proxy-traversal test to match the egress proxy's policy model, and surface netns teardown errors for the teardown-leak case.

- **Proxy-traversal test:** previously drove a loopback upstream on an ephemeral `listen(0)` port and granted only the host `127.0.0.1`. The egress proxy policy grants HOSTS at their default port (Rule 3); a non-default port requires an explicit target/credential grant the lane does not wire, and a private/loopback literal is additionally SSRF-protected. The request was therefore denied by policy (403) — correct proxy behavior, not a proxy bug — so the probe exited non-zero. The test now fetches a granted PUBLIC host on its default port (`http://example.com/`, host granted) through the host-side proxy; because the skill's netns has no off-box route except the /32 peer route to the proxy, a 2xx proves egress is proxy-only (the companion `direct-internet` lane test proves the skill cannot reach it directly).
- **`OsSandboxBackend.netnsCleanupErrors` (concrete-class getter):** captures the non-benign errors recorded by the most recent netns teardown (`netns.ts` `cleanupErrors` — EBUSY/EPERM/still-in-use; already-absent/ENOENT is treated as success and not recorded). Mirrors the existing concrete-only `skillCgroupPath` getter. The teardown lane test logs it alongside the live host-side veth state to diagnose a leaked host veth/netns.
