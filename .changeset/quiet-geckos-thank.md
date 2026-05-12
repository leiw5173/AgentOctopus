---
"@agentoctopus/skills": patch
"@agentoctopus/core": patch
"@agentoctopus/registry": patch
"@agentoctopus/adapters": patch
"@agentoctopus/gateway": patch
"@agentoctopus/cli": patch
"agentoctopus": patch
---

Bump TypeScript 5.9→6.0 and Zod 3→4 with required tsconfig and API fixes

- Add `"types": ["node"]` to root tsconfig.json (TS 6.0 no longer auto-includes @types/node)
- Migrate `z.record(V)` → `z.record(z.string(), V)` for Zod 4 compatibility
