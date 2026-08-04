# @agentoctopus/cli

## 0.9.0

### Minor Changes

- 6bc7cd0: feat: hermes E2E acceptance gate — debug telemetry, per-skill output validators, and executionId correlation

  - `@agentoctopus/core`: ExecutionContext telemetry (traceId/executionId propagation through Router→Executor→SandboxRunner); per-skill outputValidators map on Executor (skill-name-keyed lookup, backward-compatible with single outputValidator); debugEndpoints config section; fix executionId sharing so adapter.completed and sandbox.completed events use the SAME id per execute() call.
  - `@agentoctopus/gateway`: admin debug endpoint GET /agent/debug/last-run; DebugTelemetryBuffer (per-request RunRecord aggregation by traceId, executionId-based runs[] merge, ring-buffer eviction); /ask correlation-key extraction ([trace: oct-e2e-<uuid>]) with exactly-one terminal emission; per-skill validators for weather (temperature pattern) and ip-lookup (IPv4 pattern).
  - `@agentoctopus/cli`: `octopus doctor` subcommand for environment diagnostics.
  - `@agentoctopus/sandbox`: bootstrap egress proxy integration; vendored undici for proxy HTTP forwarding.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>

- a093b07: Converge every untrusted skill execution and network path on fail-closed sandbox backends. Adds canonical trusted/request schemas, immutable snapshot-only invocation payloads, backend-aware egress proxy and CA topology, persistent duplex sandbox processes for MCP, digest-pinned runtime profiles, stable installation identities, and secret-provider isolation. Removes host subprocess/network/bin-install fallbacks and unsupported legacy OpenShell behavior.
- 1d8210c: refactor(core): isolate credentials behind sandbox secret provider

  Credential VALUES are now isolated behind a host-side `SecretProvider` and reach ONLY the trusted egress proxy via `SandboxRunner.provisionSecrets` — never an LLM prompt, an `ExecSpec.env`, a log, an error, or global `process.env`.

  - Removed the credential-value interpolation from the Executor's LLM-guided subprocess (`subCredContext`) and HTTP (`credContext`) prompts, and deleted the broad `commonKeyPattern` scan that pushed `KEY = <value> (available in env)` into the prompt. Guided-path prompts now carry at most credential KEY NAMES plus a value-free `configured`/`not configured` boolean.
  - Added `buildSecretProviderFromConfig(config)` (`packages/core/src/secret-provider.ts`) which builds a `MapSecretProvider` seeded from trusted sources (credential-shaped `process.env`, `config.credentials`, and `skills.entries[*].apiKey`/`env`). Values stay inside the provider and are never logged.
  - `createDefaultSandboxRunner(secretProvider?)` now accepts an optional provider; the no-arg form still works (empty provider) for call sites that cannot reach the LLM-guided credential paths (web singleton, multi-agent instances).
  - Wired the provider at the composition roots that have config in scope: gateway `engine.ts` and the CLI `bootstrap()`. Web `ask/route.ts` and `multi-agent/agent-instance.ts` intentionally remain on the default runner (deferred — no chatClient/config in scope there).
  - `diagnoseAuthError`'s credential-presence read now uses the same read-only effective view (`effectiveCredentialEnv`) as the pre-flight guard; only presence is ever read, never values.

### Patch Changes

- 8bae9be: Align the onboarding wizard and agent sandbox config to feat/sandbox's fail-closed schema. The wizard previously offered `openshell` (a local pass-through with no real isolation) and wrote `docker.network: 'none'` plus a mutable `node:20-alpine` image tag — all removed by the canonical `SandboxConfigSchema` (docker.image must be an immutable digest; the egress proxy is the sole network egress). The wizard now offers `auto` (fail-closed best available, recommended), `docker`, `os` (restricted opt-in), `vm` (microVM), and `ssh`, and writes only `defaultBackend` so the resolver applies schema defaults. `AgentConfigSchema.sandbox.backend` in core is widened to the canonical enum to match.
- Updated dependencies [e0d70e8]
- Updated dependencies [82c1482]
- Updated dependencies [8bae9be]
- Updated dependencies [981ed72]
- Updated dependencies [2111809]
- Updated dependencies [f4304ea]
- Updated dependencies [907f4ea]
- Updated dependencies [c42c0b3]
- Updated dependencies [14d1d78]
- Updated dependencies [527f236]
- Updated dependencies [7208e49]
- Updated dependencies [5e85d3b]
- Updated dependencies [817e0c6]
- Updated dependencies [d4b64f2]
- Updated dependencies [3f54a3c]
- Updated dependencies [6bc7cd0]
- Updated dependencies
- Updated dependencies [689d833]
- Updated dependencies [eca3a3e]
- Updated dependencies [119a837]
- Updated dependencies
- Updated dependencies [773f76c]
- Updated dependencies [d0db1d7]
- Updated dependencies
- Updated dependencies [07980ee]
- Updated dependencies
- Updated dependencies [0f6ed4d]
- Updated dependencies [93d29b7]
- Updated dependencies
- Updated dependencies [e9f39ae]
- Updated dependencies [1c4e384]
- Updated dependencies
- Updated dependencies [575141f]
- Updated dependencies [94f4ca6]
- Updated dependencies [4cd6484]
- Updated dependencies [57f8e82]
- Updated dependencies
- Updated dependencies [521e64d]
- Updated dependencies [4876e12]
- Updated dependencies [c83e5c1]
- Updated dependencies
- Updated dependencies [395a999]
- Updated dependencies
- Updated dependencies [1da822a]
- Updated dependencies
- Updated dependencies [56d6b8b]
- Updated dependencies
- Updated dependencies [34e304d]
- Updated dependencies [a093b07]
- Updated dependencies [4360716]
- Updated dependencies [70871f7]
- Updated dependencies [763827c]
- Updated dependencies
- Updated dependencies [79e7d44]
- Updated dependencies [9b792d8]
- Updated dependencies [1d8210c]
- Updated dependencies [651f879]
- Updated dependencies
- Updated dependencies [e45c517]
- Updated dependencies
- Updated dependencies [be42fa1]
- Updated dependencies
- Updated dependencies [0c5eea9]
- Updated dependencies [146ef8f]
- Updated dependencies [c449e9d]
- Updated dependencies [a27bf3d]
- Updated dependencies [000a440]
- Updated dependencies
- Updated dependencies [1442cc7]
- Updated dependencies
- Updated dependencies [7783966]
- Updated dependencies
- Updated dependencies [e2fc1d9]
- Updated dependencies
- Updated dependencies [4c0ac2c]
- Updated dependencies [c0343ed]
- Updated dependencies [a525160]
- Updated dependencies [44297c0]
- Updated dependencies [1cf3c5f]
- Updated dependencies
- Updated dependencies [97a3585]
- Updated dependencies [3333869]
- Updated dependencies [674ed49]
- Updated dependencies [7256c9c]
- Updated dependencies [79c9b8f]
- Updated dependencies [d327a60]
- Updated dependencies
- Updated dependencies [a28c8ab]
- Updated dependencies
- Updated dependencies [42865c6]
- Updated dependencies
- Updated dependencies [3e5392d]
- Updated dependencies
- Updated dependencies [b43006c]
- Updated dependencies
- Updated dependencies [cbc1e3f]
  - @agentoctopus/sandbox@0.9.0
  - @agentoctopus/core@0.9.0
  - @agentoctopus/gateway@0.9.0
  - @agentoctopus/registry@0.9.0
  - @agentoctopus/skills@0.9.0

## 0.8.0

### Patch Changes

- bbad3b9: Bump TypeScript 5.9→6.0 and Zod 3→4 with required tsconfig and API fixes

  - Add `"types": ["node"]` to root tsconfig.json (TS 6.0 no longer auto-includes @types/node)
  - Migrate `z.record(V)` → `z.record(z.string(), V)` for Zod 4 compatibility

- Updated dependencies [858f227]
- Updated dependencies [858f227]
- Updated dependencies [858f227]
- Updated dependencies [858f227]
- Updated dependencies [858f227]
- Updated dependencies [bbad3b9]
- Updated dependencies [858f227]
- Updated dependencies [ac3a715]
  - @agentoctopus/core@0.8.0
  - @agentoctopus/skills@0.8.0
  - @agentoctopus/gateway@0.8.0
  - @agentoctopus/registry@0.8.0

## 0.7.0

### Minor Changes

- afdd379: Add AI-driven skill evolution: signal collection, LLM analysis, safe/risky proposal dispatch, shadow-copy rollback, CLI review commands, and onboard opt-in

### Patch Changes

- Updated dependencies [afdd379]
  - @agentoctopus/skills@0.7.0
  - @agentoctopus/core@0.7.0
  - @agentoctopus/registry@0.7.0
  - @agentoctopus/gateway@0.7.0

## 0.6.1

### Patch Changes

- e21bf1f: Fix `octopus update` failing with EEXIST when the `octopus` binary already exists in the global npm bin directory. The install now passes `--force` to npm and surfaces the actual error message on failure instead of showing a generic fallback.
  - @agentoctopus/skills@0.6.1
  - @agentoctopus/registry@0.6.1
  - @agentoctopus/core@0.6.1
  - @agentoctopus/gateway@0.6.1

## 0.6.0

### Minor Changes

- 2b4a5da: Add local scored skill search — octopus search now searches installed skills with relevance scoring. Add --run flag for interactive pick-and-run execution.

### Patch Changes

- Updated dependencies [2b4a5da]
  - @agentoctopus/skills@0.6.0
  - @agentoctopus/registry@0.6.0
  - @agentoctopus/core@0.6.0
  - @agentoctopus/gateway@0.6.0

## 0.5.19

### Patch Changes

- Bump dependencies: vectra 0.6.0→0.14.0, @google/generative-ai 0.15.0→0.24.1, @modelcontextprotocol/sdk 1.27.1→1.29.0, @types/node 20.19.37→25.6.0, eslint 9.39.4→10.3.0.
- Updated dependencies
  - @agentoctopus/skills@0.5.19
  - @agentoctopus/registry@0.5.19
  - @agentoctopus/core@0.5.19
  - @agentoctopus/gateway@0.5.19

## 0.5.17

### Patch Changes

- 48d4f1c: Rebuild CI/CD pipeline: preflight+promotion publishing, OIDC npm auth, changeset-driven versioning, composite action for DRY setup
- Updated dependencies [48d4f1c]
  - @agentoctopus/skills@0.5.17
  - @agentoctopus/registry@0.5.17
  - @agentoctopus/core@0.5.17
  - @agentoctopus/gateway@0.5.17
