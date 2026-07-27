---
"@agentoctopus/core": minor
"@agentoctopus/gateway": minor
"@agentoctopus/cli": minor
---

refactor(core): isolate credentials behind sandbox secret provider

Credential VALUES are now isolated behind a host-side `SecretProvider` and reach ONLY the trusted egress proxy via `SandboxRunner.provisionSecrets` — never an LLM prompt, an `ExecSpec.env`, a log, an error, or global `process.env`.

- Removed the credential-value interpolation from the Executor's LLM-guided subprocess (`subCredContext`) and HTTP (`credContext`) prompts, and deleted the broad `commonKeyPattern` scan that pushed `KEY = <value> (available in env)` into the prompt. Guided-path prompts now carry at most credential KEY NAMES plus a value-free `configured`/`not configured` boolean.
- Added `buildSecretProviderFromConfig(config)` (`packages/core/src/secret-provider.ts`) which builds a `MapSecretProvider` seeded from trusted sources (credential-shaped `process.env`, `config.credentials`, and `skills.entries[*].apiKey`/`env`). Values stay inside the provider and are never logged.
- `createDefaultSandboxRunner(secretProvider?)` now accepts an optional provider; the no-arg form still works (empty provider) for call sites that cannot reach the LLM-guided credential paths (web singleton, multi-agent instances).
- Wired the provider at the composition roots that have config in scope: gateway `engine.ts` and the CLI `bootstrap()`. Web `ask/route.ts` and `multi-agent/agent-instance.ts` intentionally remain on the default runner (deferred — no chatClient/config in scope there).
- `diagnoseAuthError`'s credential-presence read now uses the same read-only effective view (`effectiveCredentialEnv`) as the pre-flight guard; only presence is ever read, never values.
