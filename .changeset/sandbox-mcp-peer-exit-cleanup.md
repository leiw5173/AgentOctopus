---
"@agentoctopus/adapters": patch
"@agentoctopus/core": patch
---

Ensure a persistent sandbox MCP transport releases its runner-owned session when the peer exits, reaping the sandbox process and cleaning backend/proxy resources. Add a real Docker end-to-end lane through `SandboxRunner.bind()` and the production `SandboxMcpTransport`, covering multi-message persistence, malformed frames, peer exit, and deterministic process-tree cleanup.
