# @agentoctopus/core

## 0.8.0

### Minor Changes

- 858f227: Add install preference helpers to config resolver

  `getInstallPref(bin)` reads per-binary installation preference from
  ~/.agentoctopus/octopus.json. `saveInstallPref(bins, preference)` writes
  preferences and invalidates the in-memory config cache.

  SkillsConfigSchema gains `installPrefs: Record<string, "always" | "never" | "prompt">`.

- 858f227: Add binary auto-install support for skill execution

  When a skill requires missing binaries and declares install specs in its SKILL.md metadata (`openclaw.install`), the system now offers interactive installation instead of failing silently.

  - **New result types**: `binary_installable` (can be installed) and `binary_install_failed` (install attempted but failed with manual instructions)
  - **CLI**: Interactive prompt with always/never/prompt preferences saved to config
  - **REST API** (`/agent/ask`): Returns `binary_installable` with `installSpecs`; accepts `autoInstall: true` to trigger automatic install
  - **Chat channels** (Slack/Discord/Telegram/Webchat): Two-phase session flow — sends confirmation prompt, installs on "yes" reply
  - **Web API** (`/api/ask`): Same `binary_installable`/`binary_install_failed` response types; accepts `autoInstall` in request body
  - **Install specs**: Supports `brew`, `node`, `go`, `uv`, and `download` kinds with platform-aware filtering

### Patch Changes

- 858f227: Fix subprocess adapter to auto-chmod scripts before execution (ClawHub downloads may not preserve +x)
- bbad3b9: Bump TypeScript 5.9→6.0 and Zod 3→4 with required tsconfig and API fixes

  - Add `"types": ["node"]` to root tsconfig.json (TS 6.0 no longer auto-includes @types/node)
  - Migrate `z.record(V)` → `z.record(z.string(), V)` for Zod 4 compatibility

- 858f227: Fix reranker selection being ignored, add session context for follow-up queries, improve rerank disambiguation prompt
- ac3a715: fix(registry): pass maxCandidates: Infinity to loadSkillsFromDir so all skills are loaded instead of being capped at 300
  fix(core): handle non-array tags in skillToText before .join() to prevent gateway startup crash
  docs: fix TEST_INSTRUCTIONS.md Phase 3 test commands — correct import path and repo root
- Updated dependencies [858f227]
- Updated dependencies [858f227]
- Updated dependencies [858f227]
- Updated dependencies [858f227]
- Updated dependencies [bbad3b9]
- Updated dependencies [ac3a715]
  - @agentoctopus/adapters@0.8.0
  - @agentoctopus/skills@0.8.0
  - @agentoctopus/registry@0.8.0

## 0.7.0

### Minor Changes

- afdd379: Add AI-driven skill evolution: signal collection, LLM analysis, safe/risky proposal dispatch, shadow-copy rollback, CLI review commands, and onboard opt-in

### Patch Changes

- Updated dependencies [afdd379]
  - @agentoctopus/skills@0.7.0
  - @agentoctopus/registry@0.7.0
  - @agentoctopus/adapters@0.7.0

## 0.6.1

### Patch Changes

- @agentoctopus/skills@0.6.1
- @agentoctopus/registry@0.6.1
- @agentoctopus/adapters@0.6.1

## 0.6.0

### Minor Changes

- 2b4a5da: Add local scored skill search — octopus search now searches installed skills with relevance scoring. Add --run flag for interactive pick-and-run execution.

### Patch Changes

- Updated dependencies [2b4a5da]
  - @agentoctopus/skills@0.6.0
  - @agentoctopus/registry@0.6.0
  - @agentoctopus/adapters@0.6.0

## 0.5.19

### Patch Changes

- Bump dependencies: vectra 0.6.0→0.14.0, @google/generative-ai 0.15.0→0.24.1, @modelcontextprotocol/sdk 1.27.1→1.29.0, @types/node 20.19.37→25.6.0, eslint 9.39.4→10.3.0.
- Updated dependencies
  - @agentoctopus/skills@0.5.19
  - @agentoctopus/registry@0.5.19
  - @agentoctopus/adapters@0.5.19

## 0.5.17

### Patch Changes

- 48d4f1c: Rebuild CI/CD pipeline: preflight+promotion publishing, OIDC npm auth, changeset-driven versioning, composite action for DRY setup
- Updated dependencies [48d4f1c]
  - @agentoctopus/skills@0.5.17
  - @agentoctopus/registry@0.5.17
  - @agentoctopus/adapters@0.5.17
