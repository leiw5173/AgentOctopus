---
"@agentoctopus/skills": minor
---

Add installer functions for automatic skill binary installation

New exports: `filterInstallSpecs`, `installMissingBins`, `generateManualInstruction`.
Added `download` kind support to `dispatchInstall` with curl, tar/zip extraction,
and targetDir placement. All functions are backward-compatible with existing
`installSkillDeps` behavior.
