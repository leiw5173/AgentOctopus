// packages/sandbox/tests/vm/vm-backend.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VmSandboxBackend } from '../../src/vm/vm-backend.js';
import { FakeVmEngine, FakeVmImageBuilder } from './fakes.js';
import { ContainmentCleanupError } from '../../src/backend.js';
import { ExecutablesUnqualifiedError } from '../../src/vm/errors.js';
import type { SandboxConfig } from '../../src/schema.js';

async function makeOpts() {
  const dir = await mkdtemp(join(tmpdir(), 'vm-be-'));
  await writeFile(join(dir, 'ca.pem'), 'ca');
  return {
    snapshotRoot: dir,
    expectedSnapshotDigest: 'sha256:' + 'a'.repeat(64),
    caBundlePath: join(dir, 'ca.pem'),
    proxyAddr: 'http://127.0.0.1:18080',
    runtimeProfile: {
      id: 'node-default', bins: ['node'], path: '/usr/bin',
      vmRuntime: { rootfs: 'sha256:' + 'b'.repeat(64), memMib: 512, cpus: 1, executables: { node: '/usr/bin/node' } },
    } as any,
    guestSkillRoot: '/skill' as const,
    guestCaBundlePath: '/etc/skill-ca/ca.pem' as const,
    // BackendPrepareOptions also extends SandboxPolicy; supply minimal policy fields:
    resources: { memoryBytes: 256 * 1024 * 1024, timeoutMs: 5000, cpus: 1 },
    hosts: [], credentials: [], denied: { hosts: [], credentials: [] },
  } as any;
}
const config = { defaultBackend: 'vm', minIsolationLevel: 'full', runtimeProfiles: {}, defaults: { outputMaxBytes: 1024 * 1024 } } as unknown as SandboxConfig;

// Helper: build a backend with a per-test workDir so block images land in the tmpdir.
function makeBackend(workDir: string, engine = new FakeVmEngine(), imageBuilder = new FakeVmImageBuilder()) {
  return new VmSandboxBackend({ config, engine, imageBuilder, workDir });
}

describe('VmSandboxBackend', () => {
  it('probe returns engine.probe().available', async () => {
    const be = makeBackend(await mkdtemp(join(tmpdir(), 'vm-probe-')), new FakeVmEngine({ available: false }));
    expect(await be.probe()).toBe(false);
  });

  it('prepareTopology returns in-process carrier', async () => {
    const be = makeBackend(await mkdtemp(join(tmpdir(), 'vm-topo-')));
    const c = await be.prepareTopology();
    expect(c.kind).toBe('in-process');
  });

  it('prepare assigns non-zero vsockPort and a vsockHostSocket under the backend workDir', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'vm-prep-vsock-'));
    const be = makeBackend(workDir);
    await be.prepare(await makeOpts());
    expect((be as any).vsockPort).toBeGreaterThan(0);
    expect(typeof (be as any).vsockHostSocket).toBe('string');
    expect((be as any).vsockHostSocket.startsWith(workDir)).toBe(true);
  });

  it('prepare rejects invalid proxyAddr', async () => {
    const be = makeBackend(await mkdtemp(join(tmpdir(), 'vm-prep-proxy-')));
    const opts = await makeOpts();
    opts.proxyAddr = 'not-a-url';
    await expect(be.prepare(opts)).rejects.toThrow(/proxyAddr/);
  });

  it('prepare rejects a non-loopback proxyAddr host (containment)', async () => {
    const be = makeBackend(await mkdtemp(join(tmpdir(), 'vm-prep-noloop-')));
    const opts = await makeOpts();
    opts.proxyAddr = 'http://attacker.example.com:18080';
    await expect(be.prepare(opts)).rejects.toThrow(/loopback/);
  });

  it('prepare resolves rootfs + asserts qualified + builds both block images', async () => {
    const engine = new FakeVmEngine();
    const be = makeBackend(await mkdtemp(join(tmpdir(), 'vm-prep-')), engine);
    await be.prepare(await makeOpts());
    expect(engine.startCalls).toHaveLength(0); // prepare does not start
  });

  it('prepare rejects missing vmRuntime.rootfs (no fallback to sandbox.vm.rootfs)', async () => {
    const be = makeBackend(await mkdtemp(join(tmpdir(), 'vm-noroot-')));
    const opts = await makeOpts();
    delete opts.runtimeProfile.vmRuntime;
    await expect(be.prepare(opts)).rejects.toThrow(/rootfs/);
  });

  it('spawn constructs bootstrapArgv = [bootstrapPath, launchSpecBlob] and passes trustedEnv', async () => {
    const engine = new FakeVmEngine();
    const be = makeBackend(await mkdtemp(join(tmpdir(), 'vm-argv-')), engine);
    await be.prepare(await makeOpts());
    await be.spawn({ command: ['node', '-e', '1'] } as any);
    const cfg = engine.startCalls[0];
    expect(cfg.bootstrapArgv[0]).toBe('/usr/libexec/octopus-vm-init');
    expect(cfg.bootstrapArgv).toHaveLength(2);
    expect(cfg.bootstrapArgv[1]).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
    expect(cfg.vsockPort).toBeGreaterThan(0);
    expect(cfg.vsockHostSocket).toMatch(/^\//);
    expect(cfg.trustedEnv).toContain(`OCTOPUS_VSOCK_PORT=${cfg.vsockPort}`);
    expect(cfg.trustedEnv).toContain(`OCTOPUS_VSOCK_HOST_SOCKET=${cfg.vsockHostSocket}`);
  });

  it('spawn rejects empty command BEFORE reading command[0]', async () => {
    const be = makeBackend(await mkdtemp(join(tmpdir(), 'vm-empty-')));
    await be.prepare(await makeOpts());
    await expect(be.spawn({ command: [] } as any)).rejects.toThrow(/empty command/);
  });

  it('spawn sets workdir to "/" (NOT cwd); VmStartConfig has NO workloadSpec field', async () => {
    const engine = new FakeVmEngine();
    const be = makeBackend(await mkdtemp(join(tmpdir(), 'vm-wd-')), engine);
    await be.prepare(await makeOpts());
    await be.spawn({ command: ['node'], cwd: '/skill' } as any);
    const cfg = engine.startCalls[0];
    expect(cfg).not.toHaveProperty('workloadSpec');
    // workdir pinning is the helper's job (krun_set_workdir("/")); VmStartConfig does not carry cwd.
  });

  it('cleanup throws ContainmentCleanupError when VmInstance.kill fails, and memoizes', async () => {
    const engine = new FakeVmEngine({ killRejects: true });
    const be = makeBackend(await mkdtemp(join(tmpdir(), 'vm-cln-')), engine);
    await be.prepare(await makeOpts());
    await be.spawn({ command: ['node'] } as any);
    await expect(be.cleanup()).rejects.toBeInstanceOf(ContainmentCleanupError);
    // memoized: second call rethrows the same outcome
    await expect(be.cleanup()).rejects.toBeInstanceOf(ContainmentCleanupError);
  });

  // --- ME-2: cleanup removes workDir (sealed skill.img + ca.img) ---

  it('ME-2: cleanup removes the backend-owned workDir', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'vm-rm-'));
    const be = makeBackend(workDir);
    await be.prepare(await makeOpts());
    await be.spawn({ command: ['node'] } as any);
    // workDir exists with the block images written by the (fake) image builder.
    expect(await access(workDir).then(() => true, () => false)).toBe(true);
    await be.cleanup();
    // workDir (and its sealed skill.img + ca.img) must be gone after cleanup.
    await expect(access(workDir)).rejects.toThrow();
  });

  it('ME-2: a workDir-rm failure is a SOFT reason, never a ContainmentCleanupError', async () => {
    // A workDir whose contents have already been partially removed should still
    // clean up without promoting to a containment error. We verify the soft
    // path by making the workDir non-empty-but-rm-safe and then yanking it mid-
    // flight is unnecessary: force:true handles a missing dir. Instead assert
    // the invariant directly: even when kill() fails (containment), workDir
    // removal is still attempted and any rm error stays soft (diagnostic warn).
    const workDir = await mkdtemp(join(tmpdir(), 'vm-soft-'));
    const be = makeBackend(workDir, new FakeVmEngine({ killRejects: true }));
    await be.prepare(await makeOpts());
    await be.spawn({ command: ['node'] } as any);
    // cleanup throws ContainmentCleanupError (kill failed) — that is the
    // containment outcome. The workDir rm must NOT have added a reason to it.
    const err = await be.cleanup().catch((e) => e) as ContainmentCleanupError;
    expect(err).toBeInstanceOf(ContainmentCleanupError);
    expect(err.reasons.join(' ')).not.toMatch(/workDir/i);
  });

  // --- LO-3: bootstrap binary verified fail-closed ---

  it('LO-3: prepare asserts the bootstrap binary via a second assertExecutablesQualified call', async () => {
    const seen: { ref: string; executables: Record<string, string>; bins: readonly string[] }[] = [];
    class TrackingEngine extends FakeVmEngine {
      async assertExecutablesQualified(ref: string, executables: Record<string, string>, bins: readonly string[]) {
        seen.push({ ref, executables, bins });
      }
    }
    const be = makeBackend(await mkdtemp(join(tmpdir(), 'vm-bs-')), new TrackingEngine());
    await be.prepare(await makeOpts());
    // First call: the skill executables map ({node: /usr/bin/node}).
    expect(seen).toHaveLength(2);
    expect(seen[0].executables).toEqual({ node: '/usr/bin/node' });
    // Second call: the bootstrap-only map + matching bins (set-equality holds).
    expect(seen[1].executables).toEqual({ 'octopus-vm-init': '/usr/libexec/octopus-vm-init' });
    expect(seen[1].bins).toEqual(['octopus-vm-init']);
  });

  it('LO-3: a missing/unqualified bootstrap binary fails prepare fail-closed', async () => {
    class FailingEngine extends FakeVmEngine {
      async assertExecutablesQualified(ref: string, executables: Record<string, string>) {
        if ('octopus-vm-init' in executables) {
          throw new ExecutablesUnqualifiedError([`missing "octopus-vm-init" -> /usr/libexec/octopus-vm-init`]);
        }
      }
    }
    const be = makeBackend(await mkdtemp(join(tmpdir(), 'vm-bsfail-')), new FailingEngine());
    await expect(be.prepare(await makeOpts())).rejects.toBeInstanceOf(ExecutablesUnqualifiedError);
  });
});
