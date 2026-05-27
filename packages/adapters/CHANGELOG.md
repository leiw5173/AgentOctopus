# @agentoctopus/adapters

## 0.8.0

### Patch Changes

- 858f227: Fix subprocess adapter to auto-chmod scripts before execution (ClawHub downloads may not preserve +x)
- bbad3b9: Bump TypeScript 5.9→6.0 and Zod 3→4 with required tsconfig and API fixes

  - Add `"types": ["node"]` to root tsconfig.json (TS 6.0 no longer auto-includes @types/node)
  - Migrate `z.record(V)` → `z.record(z.string(), V)` for Zod 4 compatibility

- Updated dependencies [858f227]
- Updated dependencies [bbad3b9]
- Updated dependencies [ac3a715]
  - @agentoctopus/registry@0.8.0

## 0.7.0

### Patch Changes

- @agentoctopus/registry@0.7.0

## 0.6.1

### Patch Changes

- @agentoctopus/registry@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [2b4a5da]
  - @agentoctopus/registry@0.6.0

## 0.5.19

### Patch Changes

- Bump dependencies: vectra 0.6.0→0.14.0, @google/generative-ai 0.15.0→0.24.1, @modelcontextprotocol/sdk 1.27.1→1.29.0, @types/node 20.19.37→25.6.0, eslint 9.39.4→10.3.0.
- Updated dependencies
  - @agentoctopus/registry@0.5.19

## 0.5.17

### Patch Changes

- 48d4f1c: Rebuild CI/CD pipeline: preflight+promotion publishing, OIDC npm auth, changeset-driven versioning, composite action for DRY setup
- Updated dependencies [48d4f1c]
  - @agentoctopus/registry@0.5.17
