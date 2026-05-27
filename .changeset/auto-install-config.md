---
"@agentoctopus/core": minor
---

Add install preference helpers to config resolver

`getInstallPref(bin)` reads per-binary installation preference from
~/.agentoctopus/octopus.json. `saveInstallPref(bins, preference)` writes
preferences and invalidates the in-memory config cache.

SkillsConfigSchema gains `installPrefs: Record<string, "always" | "never" | "prompt">`.
