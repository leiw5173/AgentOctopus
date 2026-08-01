---
"@agentoctopus/sandbox": patch
---

os-helper: write `/proc/self/setgroups` "deny" only when non-root. The "deny" write exists solely to let an UNPRIVILEGED caller (no CAP_SETGID in the parent user namespace) write `gid_map`. It is a per-userns, IRREVERSIBLE flag (`USERNS_SETGROUPS_ALLOWED`): once written it permanently disables `setgroups(2)` for every process in the namespace, and cannot be undone (writing "allow" back is EPERM). The helper wrote "deny" unconditionally in phase 1, so the phase-3 child's `setgroups(0, NULL)` supplementary-group drop always failed with EPERM ("os-helper: setgroups: Operation not permitted"). A root caller (the privileged-CI runner) holds CAP_SETGID in the parent userns and writes `gid_map` without needing "deny", so the write is now skipped for root — keeping `setgroups()` available for the phase-3 drop while unprivileged users still get the mapping they need.
