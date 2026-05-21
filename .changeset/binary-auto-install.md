---
"@agentoctopus/skills": minor
"@agentoctopus/core": minor
"@agentoctopus/gateway": minor
"agentoctopus": minor
---

Add binary auto-install support for skill execution

When a skill requires missing binaries and declares install specs in its SKILL.md metadata (`openclaw.install`), the system now offers interactive installation instead of failing silently.

- **New result types**: `binary_installable` (can be installed) and `binary_install_failed` (install attempted but failed with manual instructions)
- **CLI**: Interactive prompt with always/never/prompt preferences saved to config
- **REST API** (`/agent/ask`): Returns `binary_installable` with `installSpecs`; accepts `autoInstall: true` to trigger automatic install
- **Chat channels** (Slack/Discord/Telegram/Webchat): Two-phase session flow — sends confirmation prompt, installs on "yes" reply
- **Web API** (`/api/ask`): Same `binary_installable`/`binary_install_failed` response types; accepts `autoInstall` in request body
- **Install specs**: Supports `brew`, `node`, `go`, `uv`, and `download` kinds with platform-aware filtering
