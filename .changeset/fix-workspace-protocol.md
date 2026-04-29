---
"agentoctopus": patch
"@agentoctopus/skills": patch
"@agentoctopus/registry": patch
"@agentoctopus/adapters": patch
"@agentoctopus/core": patch
"@agentoctopus/gateway": patch
"@agentoctopus/cli": patch
---

Fix published packages containing unresolved workspace:* protocol references by switching from npm pack to pnpm pack in the release pipeline.
