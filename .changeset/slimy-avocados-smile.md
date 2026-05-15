---
"@agentoctopus/core": patch
---

Fix gateway startup crash: skillToText now safely handles non-array tags in skill manifests (e.g., comma-separated string) instead of calling .join() on a non-array value. Also fix TEST_INSTRUCTIONS.md Phase 3 test commands to use correct package import path and repo root.
