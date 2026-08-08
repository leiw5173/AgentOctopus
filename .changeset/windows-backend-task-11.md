---
"@agentoctopus/sandbox": patch
---

Add `WinSandboxBackend` (native Windows restricted sandbox backend): per-session staged snapshot copy with byte-for-byte digest re-verify, LPAC/Job-Object launch via the helper, WFP gate install/remove via the companion service, and a memoized-first-outcome `cleanup()` honoring the `ContainmentCleanupError` contract. Adds the `teardownSandbox` helper wrapper and plumbs the explicit `proxyV6Loopback` field through the gate service so the dual-bind V6 permit is installable.
