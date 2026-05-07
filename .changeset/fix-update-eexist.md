---
"@agentoctopus/cli": patch
---

Fix `octopus update` failing with EEXIST when the `octopus` binary already exists in the global npm bin directory. The install now passes `--force` to npm and surfaces the actual error message on failure instead of showing a generic fallback.
