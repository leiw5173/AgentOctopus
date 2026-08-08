---
"@agentoctopus/core": patch
"@agentoctopus/sandbox": patch
---

Wire WinSandboxBackend into the runner: add windows branch to the runtime↔backend cross-check (requires windowsRuntime), compute Windows staged-copy guest paths per spec §3, and register the backend in both default factory builders.
