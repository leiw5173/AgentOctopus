---
"@agentoctopus/sandbox": patch
---

security-cleanup-linux now also kills leaked netns-mode egress-proxy node processes (`egress-proxy-server.mjs`) before tearing down their netns/nft/cgroups. On a persistent privileged runner, a session interrupted mid-run leaks the proxy process (reparented to PID 1); each leak pins its `octn-*` netns open and commits tens of MB of V8 memory, so dozens of leaks push the runner's Committed_AS past CommitLimit until Node aborts (SIGABRT, exit 134) and nested forks EAGAIN. Killing the proxies first lets the netns/cgroup teardown actually succeed and reclaims the leaked memory. Detection reads `/proc/*/cmdline` for the proxy entrypoint (never a bare `node`), SIGTERM then SIGKILL for survivors.
