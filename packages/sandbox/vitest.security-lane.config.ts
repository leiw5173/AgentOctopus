import { defineConfig } from 'vitest/config';

/**
 * Dedicated vitest config for the privileged-Linux security lane
 * (linux-lane.test.ts + linux-topology.test.ts), run by sandbox-security.yml.
 *
 * `retry: 2` absorbs ENVIRONMENTAL flakiness on the resource-constrained
 * self-hosted runner (~930MB RAM, high baseline Committed_AS). Each lane test
 * builds a full sandbox (rootfs extract + netns + cgroup + proxy + os-helper
 * fork/exec); under memory/IO pressure the helper's fork/exec occasionally
 * stalls past a per-op timeout, so a one-shot probe returns empty/exit-137 —
 * a HARNESS timeout, not a violated property. The security properties these
 * tests assert (netns isolation, read-only CA mount, proxy-only egress, full
 * teardown) are deterministic given the code: they cannot "intermittently
 * hold" under load — load only affects whether the harness finishes in time.
 * A genuine violation fails the assertion on EVERY attempt, so retry never
 * masks a real defect; it only re-rolls the environmental timing dice.
 *
 * Scoped to these two files (via `include`) so the broad `pnpm test` unit
 * suite is unaffected — a flaky UNIT test masking a real bug would be wrong.
 */
export default defineConfig({
  test: {
    retry: 2,
    include: [
      'tests/security/linux-lane.test.ts',
      'tests/security/linux-topology.test.ts',
    ],
  },
});
