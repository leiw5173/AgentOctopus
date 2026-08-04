# @agentoctopus/registry

## 0.9.0

### Minor Changes

- a093b07: Converge every untrusted skill execution and network path on fail-closed sandbox backends. Adds canonical trusted/request schemas, immutable snapshot-only invocation payloads, backend-aware egress proxy and CA topology, persistent duplex sandbox processes for MCP, digest-pinned runtime profiles, stable installation identities, and secret-provider isolation. Removes host subprocess/network/bin-install fallbacks and unsupported legacy OpenShell behavior.

### Patch Changes

- 57f8e82: Fix registry.test.ts fs mock: importing @agentoctopus/skills transitively loads @agentoctopus/sandbox → image-lock.ts, whose module-top-level loadLock() reads packages/sandbox/images/images.lock.json. The blanket `vi.mock('fs')` auto-mock made readFileSync return undefined there, crashing the whole suite at collect time with "undefined is not valid JSON". The mock now forwards images.lock.json reads to the real file and keeps the rest auto-mocked.
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
  - @agentoctopus/skills@0.9.0

## 0.8.0

### Patch Changes

- 858f227: Fix install spec extraction from ClawHub skill metadata.openclaw.install
- bbad3b9: Bump TypeScript 5.9→6.0 and Zod 3→4 with required tsconfig and API fixes

  - Add `"types": ["node"]` to root tsconfig.json (TS 6.0 no longer auto-includes @types/node)
  - Migrate `z.record(V)` → `z.record(z.string(), V)` for Zod 4 compatibility

- ac3a715: fix(registry): pass maxCandidates: Infinity to loadSkillsFromDir so all skills are loaded instead of being capped at 300
  fix(core): handle non-array tags in skillToText before .join() to prevent gateway startup crash
  docs: fix TEST_INSTRUCTIONS.md Phase 3 test commands — correct import path and repo root
- Updated dependencies [858f227]
- Updated dependencies [858f227]
- Updated dependencies [858f227]
- Updated dependencies [bbad3b9]
  - @agentoctopus/skills@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [afdd379]
  - @agentoctopus/skills@0.7.0

## 0.6.1

### Patch Changes

- @agentoctopus/skills@0.6.1

## 0.6.0

### Minor Changes

- 2b4a5da: Add local scored skill search — octopus search now searches installed skills with relevance scoring. Add --run flag for interactive pick-and-run execution.

### Patch Changes

- Updated dependencies [2b4a5da]
  - @agentoctopus/skills@0.6.0

## 0.5.19

### Patch Changes

- Bump dependencies: vectra 0.6.0→0.14.0, @google/generative-ai 0.15.0→0.24.1, @modelcontextprotocol/sdk 1.27.1→1.29.0, @types/node 20.19.37→25.6.0, eslint 9.39.4→10.3.0.
- Updated dependencies
  - @agentoctopus/skills@0.5.19

## 0.5.17

### Patch Changes

- 48d4f1c: Rebuild CI/CD pipeline: preflight+promotion publishing, OIDC npm auth, changeset-driven versioning, composite action for DRY setup
- Updated dependencies [48d4f1c]
  - @agentoctopus/skills@0.5.17
