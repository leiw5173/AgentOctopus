---
"@agentoctopus/sandbox": minor
---

Add the Linux OS sandbox backend with real self-cleaning capability probes, a digest-verified executable Node runtime root, a verified phased launcher that performs host binds before chroot and joins the selected named network namespace, fail-closed cgroup v2 attachment before untrusted exec, and session-unique /32 veth+nftables policy permitting only the topology-aware egress proxy address and actual port. The immutable skill snapshot and CA remain read-only, no forwarding/NAT or host-global sysctl mutation is used, and macOS remains `restricted`.
