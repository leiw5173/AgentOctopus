# @agentoctopus/cli

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
