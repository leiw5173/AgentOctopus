# @agentoctopus/skills

## 0.9.0

### Minor Changes

- a093b07: Converge every untrusted skill execution and network path on fail-closed sandbox backends. Adds canonical trusted/request schemas, immutable snapshot-only invocation payloads, backend-aware egress proxy and CA topology, persistent duplex sandbox processes for MCP, digest-pinned runtime profiles, stable installation identities, and secret-provider isolation. Removes host subprocess/network/bin-install fallbacks and unsupported legacy OpenShell behavior.

### Patch Changes

- Updated dependencies [e0d70e8]
- Updated dependencies [82c1482]
- Updated dependencies [981ed72]
- Updated dependencies [907f4ea]
- Updated dependencies [c42c0b3]
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
- Updated dependencies [a093b07]
- Updated dependencies [4360716]
- Updated dependencies [763827c]
- Updated dependencies
- Updated dependencies [79e7d44]
- Updated dependencies [9b792d8]
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
- Updated dependencies [7256c9c]
- Updated dependencies [79c9b8f]
- Updated dependencies [d327a60]
- Updated dependencies
- Updated dependencies [42865c6]
- Updated dependencies
- Updated dependencies [3e5392d]
- Updated dependencies
- Updated dependencies [b43006c]
- Updated dependencies
- Updated dependencies [cbc1e3f]
  - @agentoctopus/sandbox@0.9.0

## 0.8.0

### Minor Changes

- 858f227: Add installer functions for automatic skill binary installation

  New exports: `filterInstallSpecs`, `installMissingBins`, `generateManualInstruction`.
  Added `download` kind support to `dispatchInstall` with curl, tar/zip extraction,
  and targetDir placement. All functions are backward-compatible with existing
  `installSkillDeps` behavior.

- 858f227: Add binary auto-install support for skill execution

  When a skill requires missing binaries and declares install specs in its SKILL.md metadata (`openclaw.install`), the system now offers interactive installation instead of failing silently.

  - **New result types**: `binary_installable` (can be installed) and `binary_install_failed` (install attempted but failed with manual instructions)
  - **CLI**: Interactive prompt with always/never/prompt preferences saved to config
  - **REST API** (`/agent/ask`): Returns `binary_installable` with `installSpecs`; accepts `autoInstall: true` to trigger automatic install
  - **Chat channels** (Slack/Discord/Telegram/Webchat): Two-phase session flow — sends confirmation prompt, installs on "yes" reply
  - **Web API** (`/api/ask`): Same `binary_installable`/`binary_install_failed` response types; accepts `autoInstall` in request body
  - **Install specs**: Supports `brew`, `node`, `go`, `uv`, and `download` kinds with platform-aware filtering

### Patch Changes

- 858f227: Fix install spec extraction from ClawHub skill metadata.openclaw.install
- bbad3b9: Bump TypeScript 5.9→6.0 and Zod 3→4 with required tsconfig and API fixes

  - Add `"types": ["node"]` to root tsconfig.json (TS 6.0 no longer auto-includes @types/node)
  - Migrate `z.record(V)` → `z.record(z.string(), V)` for Zod 4 compatibility

## 0.7.0

### Minor Changes

- afdd379: Add AI-driven skill evolution: signal collection, LLM analysis, safe/risky proposal dispatch, shadow-copy rollback, CLI review commands, and onboard opt-in

## 0.6.1

## 0.6.0

### Minor Changes

- 2b4a5da: Add local scored skill search — octopus search now searches installed skills with relevance scoring. Add --run flag for interactive pick-and-run execution.

## 0.5.19

### Patch Changes

- Bump dependencies: vectra 0.6.0→0.14.0, @google/generative-ai 0.15.0→0.24.1, @modelcontextprotocol/sdk 1.27.1→1.29.0, @types/node 20.19.37→25.6.0, eslint 9.39.4→10.3.0.

## 0.5.17

### Patch Changes

- 48d4f1c: Rebuild CI/CD pipeline: preflight+promotion publishing, OIDC npm auth, changeset-driven versioning, composite action for DRY setup
