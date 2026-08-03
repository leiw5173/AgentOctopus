---
"@agentoctopus/sandbox": patch
"@agentoctopus/sandbox-vm-native": patch
---

Fix the four vm-lane L3/L4 failures surfaced now that the lane runs for real (G1/G2 GO, probe verified, manifest signed). 12/16 already passed; these close the remaining gaps.

- **Guest env credential containment (fail-closed).** `buildGuestEnv` previously merged the *entire* untrusted `spec.env` into the guest (`{...specEnv}`), so any host credential the caller held leaked into the VM — the L4 credential-leak escape vector. It now installs only an explicit SAFE allowlist of probe-orchestration var names (`PROBE_ACTION`, `PROBE_HOST`, `PROBE_PORT`, `HOST_CANARY_PATH`) and drops everything else, then forces the trusted proxy/CA overrides. This matches the OS sandbox's existing contract (its helper clears the env and installs only a SAFE allowlist). Unit tests updated to assert stripping + allowlist passthrough.

- **vm-init exit-frame delivery (allowlist ⇒ exit 127).** The post-ready `die()`/`die_errno()` paths wrote `{"error":…}{"exit":127}` then `_exit(127)` with **no settle delay** — unlike the workload path, which `usleep(50ms)`s before exiting. init.krun reboots the guest the moment it reaps PID 1, so the queued virtio-console tx was dropped by the device reset and the host engine never captured `guestExit`, falling back to the helper's always-0 exit code (a rejected exec misreported as success). A shared `settle_before_exit()` now bounds the shutdown race on every frame-writing exit path. `vm-init.c` is compiled into the guest rootfs by `build-vm-rootfs.mjs` (not a digest-pinned TCB artifact), so this flows through the normal rootfs rebuild.

- **Probe actions + test fixes.** Added a `pid-info` probe action (`{ ok: process.pid > 1, pid }`) so the bootstrap-integrity test asserts the workload actually runs under vm-init (the previous `metadata` action only pinged the cloud IMDS endpoint and could never report a PID). Added an `http-fetch` probe action (fetch through the egress proxy with the session CA) and rewrote the L3 curl test to use `runProbe` — it previously called `backend.run()` directly and read `result.json.ok`, but `backend.run()` returns no `.json` (only `runProbe` populates it via `parseProbeJson`), so it threw `Cannot read properties of undefined`.
