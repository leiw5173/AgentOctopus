# agentoctopus

## 0.9.0

### Minor Changes

- a093b07: Converge every untrusted skill execution and network path on fail-closed sandbox backends. Adds canonical trusted/request schemas, immutable snapshot-only invocation payloads, backend-aware egress proxy and CA topology, persistent duplex sandbox processes for MCP, digest-pinned runtime profiles, stable installation identities, and secret-provider isolation. Removes host subprocess/network/bin-install fallbacks and unsupported legacy OpenShell behavior.

### Patch Changes

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
  - @agentoctopus/cli@0.9.0
  - @agentoctopus/gateway@0.9.0
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

- Updated dependencies [858f227]
- Updated dependencies [858f227]
- Updated dependencies [858f227]
- Updated dependencies [858f227]
- Updated dependencies [bbad3b9]
- Updated dependencies [858f227]
- Updated dependencies [ac3a715]
  - @agentoctopus/adapters@0.8.0
  - @agentoctopus/core@0.8.0
  - @agentoctopus/gateway@0.8.0
  - @agentoctopus/registry@0.8.0
  - @agentoctopus/cli@0.8.0

## 0.7.0

### Minor Changes

- afdd379: Add AI-driven skill evolution: signal collection, LLM analysis, safe/risky proposal dispatch, shadow-copy rollback, CLI review commands, and onboard opt-in

### Patch Changes

- Updated dependencies [afdd379]
  - @agentoctopus/core@0.7.0
  - @agentoctopus/cli@0.7.0
  - @agentoctopus/registry@0.7.0
  - @agentoctopus/gateway@0.7.0
  - @agentoctopus/adapters@0.7.0

## 0.6.1

### Patch Changes

- Updated dependencies [e21bf1f]
  - @agentoctopus/cli@0.6.1
  - @agentoctopus/registry@0.6.1
  - @agentoctopus/adapters@0.6.1
  - @agentoctopus/core@0.6.1
  - @agentoctopus/gateway@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [2b4a5da]
  - @agentoctopus/registry@0.6.0
  - @agentoctopus/core@0.6.0
  - @agentoctopus/cli@0.6.0
  - @agentoctopus/adapters@0.6.0
  - @agentoctopus/gateway@0.6.0

## 0.5.19

### Patch Changes

- Bump dependencies: vectra 0.6.0→0.14.0, @google/generative-ai 0.15.0→0.24.1, @modelcontextprotocol/sdk 1.27.1→1.29.0, @types/node 20.19.37→25.6.0, eslint 9.39.4→10.3.0.
- Updated dependencies
  - @agentoctopus/registry@0.5.19
  - @agentoctopus/adapters@0.5.19
  - @agentoctopus/core@0.5.19
  - @agentoctopus/gateway@0.5.19
  - @agentoctopus/cli@0.5.19

## 0.5.17

### Patch Changes

- 48d4f1c: Rebuild CI/CD pipeline: preflight+promotion publishing, OIDC npm auth, changeset-driven versioning, composite action for DRY setup
- Updated dependencies [48d4f1c]
  - @agentoctopus/registry@0.5.17
  - @agentoctopus/adapters@0.5.17
  - @agentoctopus/core@0.5.17
  - @agentoctopus/gateway@0.5.17
  - @agentoctopus/cli@0.5.17
