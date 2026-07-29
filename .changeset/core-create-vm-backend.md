---
"@agentoctopus/core": minor
"@agentoctopus/sandbox": patch
---

feat(core): createVmBackend factory wires VM backend as optional native dep

Adds createVmBackend + createDefaultSandboxRunnerAsync. Exports VmSandboxBackend from @agentoctopus/sandbox barrel. Native package is optional; missing/incomplete native fails closed to {unavailable}.
