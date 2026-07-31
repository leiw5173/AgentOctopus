---
"@agentoctopus/sandbox": patch
---

Make the VM L3/L4 lane fail-closed on a missing/skipped TCB (F2).

The VM lane tests constructed VmEngineImpl with no arguments, but the
constructor requires (opts, deps) — probe() read this.deps.platform →
TypeError → the beforeAll catch swallowed it → every L3/L4 test silently
skipped → the lane passed with ZERO tests executed, proving nothing about VM
isolation. Add a shared buildLaneVmEngine() helper that wires real opts
(prebuilds paths) + createNativeDeps(), and use it in vm-lane.test.ts,
vm-escape-matrix.test.ts, and vm-lane-setup.ts. The vm-lane CI job now emits a
JSON report and runs assert-no-skipped-tests.mjs (mirroring the privileged-
linux lane), so a missing TCB fails the job → security-gate fails, rather
than silently passing. Cross-produce the rootfs on the Linux release lane
(build-vm-rootfs.mjs is Linux-only) and download it in the macOS vm-lane,
which builds its own darwin-arm64 helper + libkrun/libkrunfw in-run.
