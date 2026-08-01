---
"@agentoctopus/sandbox": patch
---

privileged-linux lane: absorb environmental flakiness with a scoped `retry: 2`.

The linux-lane + linux-topology tests build a full sandbox each (rootfs extract
+ netns + cgroup + proxy + `os-helper` fork/exec). On the resource-constrained
self-hosted runner (~930MB RAM, high baseline `Committed_AS`) the helper's
fork/exec occasionally stalls past a per-op timeout under memory/IO pressure, so
a one-shot probe returns empty/exit-137 — a HARNESS timeout, never a violated
property (netns isolation, read-only CA mount, proxy-only egress, and full
teardown are deterministic given the code). This surfaced as a *different* test
timing out on each run (proxy-traversal exit-4 one run, ca-ro-probe empty-JSON
the next) while a diagnostic run passed all 18 — the signature of contention,
not a code defect.

A new `packages/sandbox/vitest.security-lane.config.ts` (its `include` selects
exactly these two files) enables `retry: 2` for this lane only via
`--config` in `sandbox-security.yml`. retry re-rolls the environmental timing
dice; a genuine security violation fails the assertion on EVERY attempt and
still trips the `assert-no-skipped-tests.mjs` gate (empirically validated: a
test that fails twice then passes reports final status `passed`, while a test
that genuinely fails stays `failed` after exhausting retries and is flagged).
The broad `pnpm test` unit suite is untouched — a flaky unit test masking a real
bug would be wrong, so retry is confined to the privileged lane.
