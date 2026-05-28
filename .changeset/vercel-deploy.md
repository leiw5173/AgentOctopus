---
"@agentoctopus/core": patch
---

Add Vercel deployment configuration and Anthropic provider support

- Add `vercel.json` for monorepo deployment settings
- Add `.vercelignore` to exclude unnecessary files from deployment
- Add `packageManager` field to web app for pnpm detection
- Add Anthropic provider support to LLM client
