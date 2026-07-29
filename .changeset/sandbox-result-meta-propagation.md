---
"@agentoctopus/sandbox": minor
"@agentoctopus/core": minor
"@agentoctopus/adapters": minor
---

Sandbox run/session outputs now carry the full machine-readable SandboxResultMeta from the backend result verbatim. run() awaits cleanup before returning and downgrades to isolationLevel 'none' on ContainmentCleanupError; persistent sessions expose resultMeta, definitive only after close(). Session-dir and proxy-close failures surface as degradation reasons without downgrading isolation.
