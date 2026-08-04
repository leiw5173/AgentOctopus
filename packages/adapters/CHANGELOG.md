# @agentoctopus/adapters

## 0.9.0

### Minor Changes

- feat(core): converge all skill execution and network paths on the SandboxRunner

  Every non-MCP skill execution and network path now goes through the `SandboxRunner` built in the prior task. The `Adapter.invoke` boundary changed to `invoke(input: AdapterInput, context: AdapterInvocationContext)` where `context.sandbox` is a required, skill-bound `BoundSandboxExecutionPort`. There is no host execution fallback — where no sandbox context is available the path fails closed.

  - `SubprocessAdapter` delegates to `context.sandbox.run` (guest path `/skill/scripts/<entry>`); it no longer imports `child_process`.
  - `HttpAdapter` serializes `{method,url,headers,body}` into `OCTOPUS_INPUT` and executes a trusted in-sandbox `node -e` HTTP runner; it never host-fetches and never reads `process.env` API keys (the egress proxy injects credentials).
  - The Executor's LLM-guided subprocess and HTTP/curl paths run `bash -c <cmd>` inside the sandbox instead of host `cp.spawn('bash', ...)`; host `process.env` mutation for execution (`applySkillEnvOverrides`) was removed (credential pre-flight checks remain as read-only guards).
  - The Executor accepts an optional 4th constructor param `sandboxRunner?: SandboxRunner`; production call sites lazily build the real default from the trusted octopus.json sandbox config (`createDefaultSandboxRunner`).
  - Removed the legacy host `DockerAdapter`, `SshAdapter`, and `OpenShellAdapter` (replaced by the canonical backends in `@agentoctopus/sandbox`).
  - `McpAdapter` converged to the new signature only; its persistent transport is the next task's job.

- 34e304d: feat(core): converge all skill execution and network paths on the SandboxRunner

  Every non-MCP skill execution and network path now goes through the `SandboxRunner` built in the prior task. The `Adapter.invoke` boundary changed to `invoke(input: AdapterInput, context: AdapterInvocationContext)` where `context.sandbox` is a required, skill-bound `BoundSandboxExecutionPort`. There is no host execution fallback — where no sandbox context is available the path fails closed.

  - `SubprocessAdapter` delegates to `context.sandbox.run` (guest path `/skill/scripts/<entry>`); it no longer imports `child_process`.
  - `HttpAdapter` serializes `{method,url,headers,body}` into `OCTOPUS_INPUT` and executes a trusted in-sandbox `node -e` HTTP runner; it never host-fetches and never reads `process.env` API keys (the egress proxy injects credentials).
  - The Executor's LLM-guided subprocess and HTTP/curl paths run `bash -c <cmd>` inside the sandbox instead of host `cp.spawn('bash', ...)`; host `process.env` mutation for execution (`applySkillEnvOverrides`) was removed (credential pre-flight checks remain as read-only guards).
  - The Executor accepts an optional 4th constructor param `sandboxRunner?: SandboxRunner`; production call sites lazily build the real default from the trusted octopus.json sandbox config (`createDefaultSandboxRunner`).
  - Removed the legacy host `DockerAdapter`, `SshAdapter`, and `OpenShellAdapter` (replaced by the canonical backends in `@agentoctopus/sandbox`).
  - `McpAdapter` converged to the new signature only; its persistent transport is the next task's job.

- a093b07: Converge every untrusted skill execution and network path on fail-closed sandbox backends. Adds canonical trusted/request schemas, immutable snapshot-only invocation payloads, backend-aware egress proxy and CA topology, persistent duplex sandbox processes for MCP, digest-pinned runtime profiles, stable installation identities, and secret-provider isolation. Removes host subprocess/network/bin-install fallbacks and unsupported legacy OpenShell behavior.
- 9b792d8: Sandbox run/session outputs now carry the full machine-readable SandboxResultMeta from the backend result verbatim. run() awaits cleanup before returning and downgrades to isolationLevel 'none' on ContainmentCleanupError; persistent sessions expose resultMeta, definitive only after close(). Session-dir and proxy-close failures surface as degradation reasons without downgrading isolation.

### Patch Changes

- 70871f7: Ensure a persistent sandbox MCP transport releases its runner-owned session when the peer exits, reaping the sandbox process and cleaning backend/proxy resources. Add a real Docker end-to-end lane through `SandboxRunner.bind()` and the production `SandboxMcpTransport`, covering multi-message persistence, malformed frames, peer exit, and deterministic process-tree cleanup.
- Add the release-blocking sandbox security matrix and immutable runtime supply chain. The runtime image has no entrypoint or shell/network clients and executes direct argv; the egress-proxy image is self-contained. Docker, privileged Linux, proxy, persistent MCP, identity/snapshot, and macOS restricted/fail-closed lanes now prove host-canary isolation, proxy-only egress, credential scoping, redirect/framing/smuggling/DNS/TLS defenses, resource and process-tree cleanup, and digest sensitivity. Release preflight and publish require successful security results for the exact release SHA and immutable image digests.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>

- e45c517: Add the release-blocking sandbox security matrix and immutable runtime supply chain. The runtime image has no entrypoint or shell/network clients and executes direct argv; the egress-proxy image is self-contained. Docker, privileged Linux, proxy, persistent MCP, identity/snapshot, and macOS restricted/fail-closed lanes now prove host-canary isolation, proxy-only egress, credential scoping, redirect/framing/smuggling/DNS/TLS defenses, resource and process-tree cleanup, and digest sensitivity. Release preflight and publish require successful security results for the exact release SHA and immutable image digests.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>

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
  - @agentoctopus/registry@0.9.0

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
