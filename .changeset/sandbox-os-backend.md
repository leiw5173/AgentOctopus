---
"@agentoctopus/sandbox": minor
---

Enforce external proxy ownership in the Linux OS sandbox backend. The proxy lifecycle is owned solely by the canonical `SandboxRunner` + `DefaultProxyLauncher`, which launches exactly one proxy per session and closes its handle after backend teardown. `OsSandboxBackend` now consumes only the launcher-supplied `proxyAddr`/`caBundlePath`: `prepare()` validates those coordinates against the topology carrier (host/port match, rejecting before nft authorization) and trusts the orchestrator for readiness — no liveness probe in `prepare()`, no `ProxyHandle` storage, and no proxy launch or close. `cleanup()` removes backend runtime/topology only (active child, skill cgroup, rootfs, netns) and never closes an externally owned proxy. The backend's own trusted PID ceiling stays the production constant `64`. The egress proxy address/port allow rule and read-only snapshot/CA invariants are unchanged; macOS remains `restricted`.
