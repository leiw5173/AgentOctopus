---
"@agentoctopus/cli": patch
"@agentoctopus/core": patch
---

Align the onboarding wizard and agent sandbox config to feat/sandbox's fail-closed schema. The wizard previously offered `openshell` (a local pass-through with no real isolation) and wrote `docker.network: 'none'` plus a mutable `node:20-alpine` image tag — all removed by the canonical `SandboxConfigSchema` (docker.image must be an immutable digest; the egress proxy is the sole network egress). The wizard now offers `auto` (fail-closed best available, recommended), `docker`, `os` (restricted opt-in), `vm` (microVM), and `ssh`, and writes only `defaultBackend` so the resolver applies schema defaults. `AgentConfigSchema.sandbox.backend` in core is widened to the canonical enum to match.
