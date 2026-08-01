---
"@agentoctopus/sandbox": patch
---

os-helper: map the untrusted overflow id (65534) in BOTH uid_map and gid_map, and drop the phase-3 `setgroups()` call. Two layered fixes for the privileged-lane userns pivot:

1. **setgid EINVAL.** The helper drops to uid/gid 65534 ("nobody"), but the uid_map/gid_map only mapped in-ns id 0 → real id ("0 rid 1"). `setuid(65534)` happened to work (an unmapped uid resolves to the overflow uid 65534 via the nameless-uid path), but there is no gid equivalent — `setgid(65534)` to an UNMAPPED gid is EINVAL even for root-in-userns. That latent bug was masked while the helper died earlier at setgroups. The maps now carry a second line mapping the in-ns drop target to the host overflow id: `0 rid 1\n<target> 65534 1`.

2. **setgroups EPERM.** Writing the now-multi-line gid_map requires `/proc/self/setgroups` "deny" first (the kernel's unprivileged single-line self-map path can't express two lines). "deny" is per-userns and IRREVERSIBLE — it permanently disables `setgroups(2)` for the namespace, so the phase-3 `setgroups(0, NULL)` would EPERM. That call is dropped: it is a no-op here (the runner runs with no supplementary groups — `Groups:` empty), and `setgid()`/`setuid()` are unaffected by "deny".

The runner's capability diagnostic confirmed CapBnd/CapEff = full set (the earlier "missing CAP_SETGID" inference was wrong) and `Groups:` empty (no supplementary groups to drop). `probe_namespaces` mirrors the same two-line map.
