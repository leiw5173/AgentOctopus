/**
 * Linux-gated smoke test for OsSandboxBackend (Plan 4, Task 5).
 *
 * This file MUST compile on macOS and skip cleanly. Real kernel operations
 * (netns, cgroup, chroot, the C helper) only execute on a capable Linux host.
 *
 * `OCTOPUS_REQUIRE_OS_SANDBOX=1` converts a capability skip into a hard
 * failure on the Plan 6 privileged lane.
 */
import { describe, it, expect } from 'vitest';
import { OsSandboxBackend } from '../src/os/os-backend.js';

const isLinux = process.platform === 'linux';
// Real kernel operations need root: `ip netns add` writes /run/netns and the
// os-helper asserts euid 0. A plain CI runner (ubuntu-latest) is Linux but
// unprivileged — the smoke must skip there, not fail spuriously.
const canRunOsSmoke = isLinux && typeof process.getuid === 'function' && process.getuid() === 0;
const REQUIRE_OS = process.env.OCTOPUS_REQUIRE_OS_SANDBOX === '1';

// Hard-fail guard: on the Plan 6 lane REQUIRE_OS=1 is set to convert any
// capability skip into a hard failure. If the env is set but the test is
// being collected on a host that cannot run the real smoke (non-Linux or
// unprivileged), the whole gated block would silently skip and the lane would
// appear green. This portable test forces the lane to fail loudly instead.
describe('OCTOPUS_REQUIRE_OS_SANDBOX contract (os-backend)', () => {
  it('hard-fails when REQUIRE_OS=1 but the host cannot run the real os-backend smoke', () => {
    if (REQUIRE_OS && !canRunOsSmoke) {
      throw new Error(
        'OCTOPUS_REQUIRE_OS_SANDBOX=1 but the os-backend smoke cannot run here ' +
        '(platform or root capability missing) — the lane cannot silently regress',
      );
    }
  });
});

describe.skipIf(!canRunOsSmoke)('OsSandboxBackend — real Linux smoke', () => {
  it('probe() returns true on a capable host', async () => {
    if (REQUIRE_OS) {
      // On the Plan 6 privileged lane this test MUST run end-to-end. Any
      // capability failure surfaces via the throws below, not via a skip.
    }
    const b = new OsSandboxBackend({ sessionId: `smoke-${process.pid}` });
    const ok = await b.probe();
    expect(ok).toBe(true);
    expect(b.isolationLevel).toBe('full');
    await b.cleanup();
  }, 30000);

  it('prepareTopology returns a linux-static carrier with a real port', async () => {
    const b = new OsSandboxBackend({ sessionId: `smoke-${process.pid}` });
    const ok = await b.probe();
    expect(ok).toBe(true);
    const carrier = await b.prepareTopology();
    expect(carrier.kind).toBe('linux-static');
    if (carrier.kind === 'linux-static') {
      expect(carrier.listenPort).toBeGreaterThan(0);
      expect(carrier.listenPort).toBeLessThanOrEqual(65535);
      expect(carrier.listenHost).toMatch(/^169\.254\.\d+\.1$/);
      expect(carrier.reachableHost).toBe(carrier.listenHost);
      expect(carrier.skillNamespace.name).toMatch(/^octn-/);
      expect(carrier.skillNamespace.path).toMatch(/^\/run\/netns\//);
      expect(carrier.binaryPath).toMatch(/egress-proxy-server\.mjs$/);
    }
    await b.cleanup();
  }, 30000);
});
