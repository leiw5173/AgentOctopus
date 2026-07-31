---
"@agentoctopus/registry": patch
---

Fix registry.test.ts fs mock: importing @agentoctopus/skills transitively loads @agentoctopus/sandbox → image-lock.ts, whose module-top-level loadLock() reads packages/sandbox/images/images.lock.json. The blanket `vi.mock('fs')` auto-mock made readFileSync return undefined there, crashing the whole suite at collect time with "undefined is not valid JSON". The mock now forwards images.lock.json reads to the real file and keeps the rest auto-mocked.
