# @agentoctopus/registry

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
