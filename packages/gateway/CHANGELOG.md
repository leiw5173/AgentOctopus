# @agentoctopus/gateway

## 0.9.0

### Minor Changes

- 6bc7cd0: feat: hermes E2E acceptance gate — debug telemetry, per-skill output validators, and executionId correlation

  - `@agentoctopus/core`: ExecutionContext telemetry (traceId/executionId propagation through Router→Executor→SandboxRunner); per-skill outputValidators map on Executor (skill-name-keyed lookup, backward-compatible with single outputValidator); debugEndpoints config section; fix executionId sharing so adapter.completed and sandbox.completed events use the SAME id per execute() call.
  - `@agentoctopus/gateway`: admin debug endpoint GET /agent/debug/last-run; DebugTelemetryBuffer (per-request RunRecord aggregation by traceId, executionId-based runs[] merge, ring-buffer eviction); /ask correlation-key extraction ([trace: oct-e2e-<uuid>]) with exactly-one terminal emission; per-skill validators for weather (temperature pattern) and ip-lookup (IPv4 pattern).
  - `@agentoctopus/cli`: `octopus doctor` subcommand for environment diagnostics.
  - `@agentoctopus/sandbox`: bootstrap egress proxy integration; vendored undici for proxy HTTP forwarding.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>

- 1d8210c: refactor(core): isolate credentials behind sandbox secret provider

  Credential VALUES are now isolated behind a host-side `SecretProvider` and reach ONLY the trusted egress proxy via `SandboxRunner.provisionSecrets` — never an LLM prompt, an `ExecSpec.env`, a log, an error, or global `process.env`.

  - Removed the credential-value interpolation from the Executor's LLM-guided subprocess (`subCredContext`) and HTTP (`credContext`) prompts, and deleted the broad `commonKeyPattern` scan that pushed `KEY = <value> (available in env)` into the prompt. Guided-path prompts now carry at most credential KEY NAMES plus a value-free `configured`/`not configured` boolean.
  - Added `buildSecretProviderFromConfig(config)` (`packages/core/src/secret-provider.ts`) which builds a `MapSecretProvider` seeded from trusted sources (credential-shaped `process.env`, `config.credentials`, and `skills.entries[*].apiKey`/`env`). Values stay inside the provider and are never logged.
  - `createDefaultSandboxRunner(secretProvider?)` now accepts an optional provider; the no-arg form still works (empty provider) for call sites that cannot reach the LLM-guided credential paths (web singleton, multi-agent instances).
  - Wired the provider at the composition roots that have config in scope: gateway `engine.ts` and the CLI `bootstrap()`. Web `ask/route.ts` and `multi-agent/agent-instance.ts` intentionally remain on the default runner (deferred — no chatClient/config in scope there).
  - `diagnoseAuthError`'s credential-presence read now uses the same read-only effective view (`effectiveCredentialEnv`) as the pre-flight guard; only presence is ever read, never values.

### Patch Changes

- Updated dependencies [82c1482]
- Updated dependencies [8bae9be]
- Updated dependencies [981ed72]
- Updated dependencies [2111809]
- Updated dependencies [f4304ea]
- Updated dependencies [c42c0b3]
- Updated dependencies [14d1d78]
- Updated dependencies [6bc7cd0]
- Updated dependencies [57f8e82]
- Updated dependencies
- Updated dependencies [34e304d]
- Updated dependencies [a093b07]
- Updated dependencies [70871f7]
- Updated dependencies [9b792d8]
- Updated dependencies [1d8210c]
- Updated dependencies
- Updated dependencies [e45c517]
- Updated dependencies [000a440]
- Updated dependencies
- Updated dependencies [97a3585]
- Updated dependencies [3333869]
- Updated dependencies [674ed49]
- Updated dependencies
- Updated dependencies [a28c8ab]
- Updated dependencies
- Updated dependencies [cbc1e3f]
  - @agentoctopus/core@0.9.0
  - @agentoctopus/registry@0.9.0
  - @agentoctopus/adapters@0.9.0

## 0.8.0

### Minor Changes

- 858f227: Add binary auto-install support for skill execution

  When a skill requires missing binaries and declares install specs in its SKILL.md metadata (`openclaw.install`), the system now offers interactive installation instead of failing silently.

  - **New result types**: `binary_installable` (can be installed) and `binary_install_failed` (install attempted but failed with manual instructions)
  - **CLI**: Interactive prompt with always/never/prompt preferences saved to config
  - **REST API** (`/agent/ask`): Returns `binary_installable` with `installSpecs`; accepts `autoInstall: true` to trigger automatic install
  - **Chat channels** (Slack/Discord/Telegram/Webchat): Two-phase session flow — sends confirmation prompt, installs on "yes" reply
  - **Web API** (`/api/ask`): Same `binary_installable`/`binary_install_failed` response types; accepts `autoInstall` in request body
  - **Install specs**: Supports `brew`, `node`, `go`, `uv`, and `download` kinds with platform-aware filtering

### Patch Changes

- bbad3b9: Bump TypeScript 5.9→6.0 and Zod 3→4 with required tsconfig and API fixes

  - Add `"types": ["node"]` to root tsconfig.json (TS 6.0 no longer auto-includes @types/node)
  - Migrate `z.record(V)` → `z.record(z.string(), V)` for Zod 4 compatibility

- 858f227: Fix reranker selection being ignored, add session context for follow-up queries, improve rerank disambiguation prompt
- Updated dependencies [858f227]
- Updated dependencies [858f227]
- Updated dependencies [858f227]
- Updated dependencies [858f227]
- Updated dependencies [bbad3b9]
- Updated dependencies [858f227]
- Updated dependencies [ac3a715]
  - @agentoctopus/adapters@0.8.0
  - @agentoctopus/core@0.8.0
  - @agentoctopus/registry@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [afdd379]
  - @agentoctopus/core@0.7.0
  - @agentoctopus/registry@0.7.0
  - @agentoctopus/adapters@0.7.0

## 0.6.1

### Patch Changes

- @agentoctopus/registry@0.6.1
- @agentoctopus/adapters@0.6.1
- @agentoctopus/core@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [2b4a5da]
  - @agentoctopus/registry@0.6.0
  - @agentoctopus/core@0.6.0
  - @agentoctopus/adapters@0.6.0

## 0.5.19

### Patch Changes

- Bump dependencies: vectra 0.6.0→0.14.0, @google/generative-ai 0.15.0→0.24.1, @modelcontextprotocol/sdk 1.27.1→1.29.0, @types/node 20.19.37→25.6.0, eslint 9.39.4→10.3.0.
- Updated dependencies
  - @agentoctopus/registry@0.5.19
  - @agentoctopus/adapters@0.5.19
  - @agentoctopus/core@0.5.19

## 0.5.17

### Patch Changes

- 48d4f1c: Rebuild CI/CD pipeline: preflight+promotion publishing, OIDC npm auth, changeset-driven versioning, composite action for DRY setup
- Updated dependencies [48d4f1c]
  - @agentoctopus/registry@0.5.17
  - @agentoctopus/adapters@0.5.17
  - @agentoctopus/core@0.5.17
