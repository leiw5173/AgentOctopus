---
"@agentoctopus/core": minor
"@agentoctopus/sandbox": minor
---

Add a native Windows restricted sandbox backend (`WinSandboxBackend`) for hosts without WSL2/Hyper-V/Docker Desktop. It delivers honest `restricted`-level isolation by layering user-mode Windows primitives — Job Object limits (`KILL_ON_JOB_CLOSE`), LPAC capability lockdown at Low Integrity Level, and a persistent WFP egress allowlist (permits only the loopback proxy for the skill's package SID) — enforced by a privileged `OctopusSandboxGate` companion service over a strictly-ACL'd named-pipe RPC. Selection is opt-in only via a new `defaultBackend:'windows'` + `minIsolationLevel:'restricted'` pair; a new `windowsRuntime { manifestPath, nodePath, bootstrapPath }` profile block carries the verified Node runtime. The runner gains a `windows` branch in the runtime↔backend cross-check and registers the backend in both default factory builders. Never claims `full` isolation; `auto` never selects it.
