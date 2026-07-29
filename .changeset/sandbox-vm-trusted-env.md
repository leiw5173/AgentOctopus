---
"@agentoctopus/sandbox": minor
---

VM trusted guest env construction: `buildGuestEnv` builds the final `KEY=VALUE[]` env array with untrusted `spec.env` first, then trusted proxy/CA overrides that win on collision (security invariant).
