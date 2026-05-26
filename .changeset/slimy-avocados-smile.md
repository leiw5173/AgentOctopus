---
"@agentoctopus/registry": patch
"@agentoctopus/core": patch
---

fix(registry): pass maxCandidates: Infinity to loadSkillsFromDir so all skills are loaded instead of being capped at 300
fix(core): handle non-array tags in skillToText before .join() to prevent gateway startup crash
docs: fix TEST_INSTRUCTIONS.md Phase 3 test commands — correct import path and repo root
