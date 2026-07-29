---
"@agentoctopus/core": patch
---

Each sandbox session now uses a unique private 0700 working directory, and the per-session egress-proxy CA bundle is created exclusively inside it and removed at cleanup, eliminating shared ca.pem overwrite across concurrent sessions. Session-dir removal failure is treated as host hygiene, not containment.
