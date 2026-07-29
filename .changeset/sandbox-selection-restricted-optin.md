---
"@agentoctopus/sandbox": patch
---

Backend selection now probes eligible candidates before ranking, so the Linux OS backend remains selectable under auto/full once it proves full isolation, and adds a guard so a restricted OS backend can never be chosen implicitly. This change adds no macOS execution capability; it only tightens selection semantics.
