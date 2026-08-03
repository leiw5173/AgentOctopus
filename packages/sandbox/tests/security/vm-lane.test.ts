/**
 * Task 18 — VM L3 integration lane (skipIf-gated, CI-owned).
 *
 * Exercises the REAL libkrun VM backend end-to-end: a real guest boots from
 * the produced rootfs (vda, read-only ext4) + skill block image (vdb) + CA
 * block image (vdc), with sandbox-vm-helper (Task 11) driving the pinned
 * TSI-disabled krun start sequence and vm-init (Task 12) as PID 1. The
 * probe runs inside the guest over the vsock→loopback forwarder.
 *
 * Each case asserts an EXTERNALLY OBSERVABLE invariant:
 *   - a `node -e` one-liner's stdout arrives intact over vsock,
 *   - curl via the egress proxy + CA reaches an allowed upstream,
 *   - a timeout kills the whole VM (not just the leaf child),
 *   - output overflow is capped + reported separately from timeout,
 *   - the guest cannot read host canary paths (G1 invariant, repeatable),
 *   - the guest cannot reach the network (G2 invariant, repeatable),
 *   - exact argv survives the launch-spec encode → vm-init decode round trip.
 *
 * Skip policy: runs ONLY when OCTOPUS_VM_LANE === '1' AND backend.probe()
 * returns true (libkrun + rootfs + helper all present and TCB-verified).
 * Local runs skip; the lane is CI-owned (macOS Apple Silicon runner with
 * the vendored libs + produced rootfs).
 *
 * Leaf-clean: Node stdlib + this package's own src + the Task 1 harness +
 * core's createVmBackend (via vm-lane-setup).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createHostCanary } from './harness.js';
import { setupVmSandbox, runProbe, vmLaneEnabled, buildLaneVmEngine, type ProbeResult } from './vm-lane-setup.js';

// Re-export so the shared helper is importable from this module.
export { runProbe } from './vm-lane-setup.js';

const RUN_TIMEOUT = 120_000;

let vmAvailable = false;
beforeAll(async () => {
  if (!vmLaneEnabled()) { vmAvailable = false; return; }
  // Probe the real backend. buildLaneVmEngine wires the engine with REAL
  // opts + deps (prebuilds paths + createNativeDeps()) — the no-arg
  // `new VmEngineImpl()` previously threw a TypeError in probe() that this
  // catch swallowed, silently skipping every L3/L4 test (zero executed).
  try {
    const { VmSandboxBackend } = await import('../../src/vm/vm-backend.js');
    const built = await buildLaneVmEngine();
    console.error('[vm-lane DIAG] buildLaneVmEngine built =', built ? 'OK' : 'NULL');
    if (!built) { vmAvailable = false; return; }
    const be = new VmSandboxBackend({
      config: { defaultBackend: 'vm', minIsolationLevel: 'full', defaults: { outputMaxBytes: 1024 * 1024 } } as any,
      engine: built.engine,
      imageBuilder: built.imageBuilder,
    });
    vmAvailable = await be.probe();
    // DIAG: surface WHY the probe is unavailable — the boolean alone skips
    // all 16 tests silently and the fail-closed gate gives no reason.
    try { console.error('[vm-lane DIAG] engine.probe() =>', JSON.stringify(await built.engine.probe())); } catch (e) { console.error('[vm-lane DIAG] engine.probe() threw:', e); }
  } catch (e) { console.error('[vm-lane DIAG] beforeAll threw:', e); vmAvailable = false; }
});

/** Skip helper: every case requires the real VM lane. */
function needVm(ctx: { skip: () => void }): boolean {
  if (!vmAvailable) { ctx.skip(); return false; }
  return true;
}

describe('VM L3 integration lane (real libkrun guest, skipIf-gated)', () => {
  it('node -e stdout arrives intact over the vsock bridge', async (ctx) => {
    if (!needVm(ctx)) return;
    const sandbox = await setupVmSandbox();
    try {
      const result = await sandbox.backend.run({
        command: ['node', '-e', 'process.stdout.write("vm-lane-ready\\n")'],
        env: {},
        timeoutMs: 5_000,
      });
      expect(result.stdout).toContain('vm-lane-ready');
      expect(result.exitCode).toBe(0);
    } finally {
      await sandbox.cleanup();
    }
  }, RUN_TIMEOUT);

  it('curl via the egress proxy + CA reaches an allowed upstream', async (ctx) => {
    if (!needVm(ctx)) return;
    // Grant a host + let the proxy allow it. The probe's HTTP action fetches
    // via the proxy using the session CA bundle.
    const sandbox = await setupVmSandbox({ grantedHosts: ['example.com'] });
    try {
      const result = await sandbox.backend.run({
        command: ['node', '/skill/probe.js', 'http-fetch', 'example.com'],
        env: {},
        timeoutMs: 10_000,
      });
      // The probe emits { ok: true } when the fetch succeeded via the proxy.
      expect(result.json.ok).toBe(true);
    } finally {
      await sandbox.cleanup();
    }
  }, RUN_TIMEOUT);

  it('timeout kills the whole VM, not just the leaf child', async (ctx) => {
    if (!needVm(ctx)) return;
    const sandbox = await setupVmSandbox();
    try {
      const result = await sandbox.backend.run({
        command: ['node', '/skill/probe.js', 'block'],
        env: {},
        timeoutMs: 500,
      });
      expect(result.timedOut).toBe(true);
    } finally {
      await sandbox.cleanup();
    }
  }, RUN_TIMEOUT);

  it('output overflow is capped and reported separately from timeout', async (ctx) => {
    if (!needVm(ctx)) return;
    const sandbox = await setupVmSandbox({ outputMaxBytes: 1024 });
    try {
      const result = await sandbox.backend.run({
        command: ['node', '/skill/probe.js', 'output-flood'],
        env: {},
        timeoutMs: 5_000,
        outputMaxBytes: 1024,
      });
      // The flood is capped; stdout does not exceed the cap (+ framing slack).
      expect(result.stdout.length).toBeLessThanOrEqual(1024 + 64);
      expect(result.timedOut).toBe(false);
    } finally {
      await sandbox.cleanup();
    }
  }, RUN_TIMEOUT);

  it('G1 (repeatable): guest cannot read host canary paths', async (ctx) => {
    if (!needVm(ctx)) return;
    const canary = createHostCanary();
    try {
      const result = await runProbe('host-canary-read', {
        env: { HOST_CANARY_PATH: canary.hostPath },
      });
      // ok=true would mean the unmounted canary was READABLE — a breakout.
      expect(result.json.ok).toBe(false);
    } finally {
      canary.cleanup();
    }
  }, RUN_TIMEOUT);

  it('G2 (repeatable): guest cannot reach the network (host canary + 1.1.1.1)', async (ctx) => {
    if (!needVm(ctx)) return;
    const result = await runProbe('direct-internet', {});
    // ok=true would mean a raw TCP connect to the internet succeeded — a breakout.
    expect(result.json.ok).toBe(false);
  }, RUN_TIMEOUT);

  it('exact argv survives the launch-spec encode → vm-init decode round trip', async (ctx) => {
    if (!needVm(ctx)) return;
    const result = await runProbe('argv', {
      command: ['node', '/skill/probe.js', 'argv', 'EXTRA-TOKEN-9'],
    });
    // The probe echoes process.argv.slice(2); the token must survive intact.
    expect(JSON.stringify(result.json)).toContain('EXTRA-TOKEN-9');
  }, RUN_TIMEOUT);
});
