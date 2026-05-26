---
"@agentoctopus/adapters": patch
"@agentoctopus/core": patch
---

Fix subprocess adapter to auto-chmod scripts before execution (ClawHub downloads may not preserve +x)
