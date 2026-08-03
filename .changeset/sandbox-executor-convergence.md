---
"@agentoctopus/core": minor
"@agentoctopus/adapters": minor
---

feat(core): converge all skill execution and network paths on the SandboxRunner

Every non-MCP skill execution and network path now goes through the `SandboxRunner` built in the prior task. The `Adapter.invoke` boundary changed to `invoke(input: AdapterInput, context: AdapterInvocationContext)` where `context.sandbox` is a required, skill-bound `BoundSandboxExecutionPort`. There is no host execution fallback — where no sandbox context is available the path fails closed.

- `SubprocessAdapter` delegates to `context.sandbox.run` (guest path `/skill/scripts/<entry>`); it no longer imports `child_process`.
- `HttpAdapter` serializes `{method,url,headers,body}` into `OCTOPUS_INPUT` and executes a trusted in-sandbox `node -e` HTTP runner; it never host-fetches and never reads `process.env` API keys (the egress proxy injects credentials).
- The Executor's LLM-guided subprocess and HTTP/curl paths run `bash -c <cmd>` inside the sandbox instead of host `cp.spawn('bash', ...)`; host `process.env` mutation for execution (`applySkillEnvOverrides`) was removed (credential pre-flight checks remain as read-only guards).
- The Executor accepts an optional 4th constructor param `sandboxRunner?: SandboxRunner`; production call sites lazily build the real default from the trusted octopus.json sandbox config (`createDefaultSandboxRunner`).
- Removed the legacy host `DockerAdapter`, `SshAdapter`, and `OpenShellAdapter` (replaced by the canonical backends in `@agentoctopus/sandbox`).
- `McpAdapter` converged to the new signature only; its persistent transport is the next task's job.
