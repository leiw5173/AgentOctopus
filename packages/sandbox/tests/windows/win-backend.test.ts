// packages/sandbox/tests/windows/win-backend.test.ts
//
// Cross-platform lifecycle + fail-closed contract for WinSandboxBackend.
// The class gates on process.platform === 'win32' FIRST, but every
// side-effecting collaborator (runtime-manifest verify, helper self-test,
// gate install/remove, staged copy, sandboxed launch, teardown)
// is injectable via the constructor `deps` seam — so the full lifecycle,
// cleanup ordering, and the memoized-first-outcome ContainmentCleanupError
// contract are exercised on this (macOS) host without Windows.
import { describe, it, expect } from 'vitest';
import { WinSandboxBackend } from '../../src/windows/win-backend.js';
import { stageVerifiedCopy } from '../../src/windows/stage-copy.js';
import { spawnHelper } from '../../src/windows/helper-spawn.js';
import { ContainmentCleanupError } from '../../src/backend.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const DIGEST = `sha256:${'0'.repeat(64)}`;

function okDeps() {
  return {
    platform: 'win32',
    verifyRuntime: async () => true,
    probeHelper: async () => true,
    gateAvailable: async () => true,
    // Run-11 Step-4c seam: tests stand in for the session node.exe copy. The
    // fake mirrors the default's path shape (sessionDir/node.exe) so gate +
    // launch assertions read the copy path, never the toolchain nodePath.
    stageLaunchNode: async (sessionDir: string, _src: string) => path.join(sessionDir, 'node.exe'),
  };
}

describe('WinSandboxBackend probe', () => {
  it('reports none before probe and restricted after a successful (injected) probe', async () => {
    const b = new WinSandboxBackend({ sessionId: 't', deps: okDeps() });
    expect(b.kind).toBe('windows');
    expect(b.isolationLevel).toBe('none');
    expect(await b.probe()).toBe(true);
    expect(b.isolationLevel).toBe('restricted');
  });

  it('fails closed when the gate is unavailable', async () => {
    const b = new WinSandboxBackend({
      sessionId: 't',
      deps: { ...okDeps(), gateAvailable: async () => false },
    });
    expect(await b.probe()).toBe(false);
    expect(b.isolationLevel).toBe('none');
  });

  it('no DI override: probe() gates on the real platform (fail-closed off win32)', async () => {
    // No platform override → the backend reads the real process.platform. The
    // fail-closed contract being asserted is "probe() never reports a Windows
    // backend available on a non-Windows host". On a non-Windows host that
    // means probe() === false. On a REAL Windows host (the windows-restricted
    // CI lane) the same no-override probe() correctly runs the real
    // verify/helper/gate path and returns true (full runtime manifest + running
    // LocalSystem gate service present) — so asserting false there would be
    // wrong, and skipping is not allowed (the lane forbids skipped tests).
    // The assertion is therefore platform-aware: false off win32 (fail-closed),
    // true on win32 (genuinely available). This never weakens the gate — the
    // win32 branch is the backend behaving exactly as designed on its target
    // platform, and the non-win32 branch is the fail-closed invariant.
    const b = new WinSandboxBackend({ sessionId: 't' });
    const expected = process.platform === 'win32';
    expect(await b.probe()).toBe(expected);
    expect(b.isolationLevel).toBe(expected ? 'restricted' : 'none');
  });

  it('fails closed when the runtime manifest cannot be verified', async () => {
    const b = new WinSandboxBackend({
      sessionId: 't',
      deps: { ...okDeps(), verifyRuntime: async () => { throw new Error('digest mismatch'); } },
    });
    expect(await b.probe()).toBe(false);
    expect(b.isolationLevel).toBe('none');
  });

  it('fails closed when the helper self-test fails', async () => {
    const b = new WinSandboxBackend({
      sessionId: 't',
      deps: { ...okDeps(), probeHelper: async () => false },
    });
    expect(await b.probe()).toBe(false);
    expect(b.isolationLevel).toBe('none');
  });
});

describe('WinSandboxBackend topology/prepare/spawn', () => {
  it('prepareTopology returns the in-process loopback carrier', async () => {
    const b = new WinSandboxBackend({ sessionId: 't', deps: okDeps() });
    await b.probe();
    const carrier = await b.prepareTopology();
    expect(carrier).toEqual({ kind: 'in-process', listenHost: '127.0.0.1', reachableHost: '127.0.0.1' });
  });

  it('prepare throws before a successful probe (fail-closed)', async () => {
    const b = new WinSandboxBackend({ sessionId: 't', deps: okDeps() });
    await expect(
      b.prepare({
        snapshotRoot: '/x',
        expectedSnapshotDigest: DIGEST,
        proxyAddr: 'http://127.0.0.1:8080',
        caBundlePath: '/ca.pem',
        runtimeProfile: {
          id: 'r', bins: [], path: '',
          windowsRuntime: { manifestPath: 'm', nodePath: 'n', bootstrapPath: 'b' },
        },
        guestSkillRoot: '/session/skill', guestCaBundlePath: '/session/ca.pem',
        resources: { memoryBytes: 1 << 20, cpus: 1, timeoutMs: 1000 },
      } as never),
    ).rejects.toThrow(/probe/);
  });

  it('prepare rejects a malformed expectedSnapshotDigest (format gate)', async () => {
    const b = new WinSandboxBackend({ sessionId: 't', deps: okDeps() });
    await b.probe();
    await b.prepareTopology();
    await expect(
      b.prepare({
        snapshotRoot: '/x',
        expectedSnapshotDigest: 'not-a-digest',
        proxyAddr: 'http://127.0.0.1:8080',
        caBundlePath: '/ca.pem',
        runtimeProfile: {
          id: 'r', bins: [], path: '',
          windowsRuntime: { manifestPath: 'm', nodePath: 'n', bootstrapPath: 'b' },
        },
        guestSkillRoot: '/session/skill', guestCaBundlePath: '/session/ca.pem',
        resources: { memoryBytes: 1 << 20, cpus: 1, timeoutMs: 1000 },
      } as never),
    ).rejects.toThrow(/expectedSnapshotDigest/);
  });

  it('prepare requires runtimeProfile.windowsRuntime', async () => {
    const b = new WinSandboxBackend({ sessionId: 't', deps: okDeps() });
    await b.probe();
    await b.prepareTopology();
    await expect(
      b.prepare({
        snapshotRoot: '/x',
        expectedSnapshotDigest: DIGEST,
        proxyAddr: 'http://127.0.0.1:8080',
        caBundlePath: '/ca.pem',
        runtimeProfile: { id: 'r', bins: [], path: '' },
        guestSkillRoot: '/session/skill', guestCaBundlePath: '/session/ca.pem',
        resources: { memoryBytes: 1 << 20, cpus: 1, timeoutMs: 1000 },
      } as never),
    ).rejects.toThrow(/windowsRuntime/);
  });

  it('prepare throws when staged guestSkillRoot does not match opts.guestSkillRoot (fail-closed contract)', async () => {
    const b = new WinSandboxBackend({
      sessionId: 't',
      deps: {
        ...okDeps(),
        // The fake stageCopy returns a DIFFERENT path than the runner declared.
        stageCopy: async () => ({ guestSkillRoot: '/wrong/skill', guestCaBundlePath: '/session/ca.pem' }),
      } as never,
    });
    await b.probe();
    await b.prepareTopology();
    await expect(
      b.prepare({
        snapshotRoot: '/x',
        expectedSnapshotDigest: DIGEST,
        proxyAddr: 'http://127.0.0.1:8080',
        caBundlePath: '/ca.pem',
        runtimeProfile: {
          id: 'r', bins: [], path: '',
          windowsRuntime: { manifestPath: 'm', nodePath: 'n', bootstrapPath: 'b' },
        },
        guestSkillRoot: '/session/skill', guestCaBundlePath: '/session/ca.pem',
        resources: { memoryBytes: 1 << 20, cpus: 1, timeoutMs: 1000 },
      } as never),
    ).rejects.toThrow(/guestSkillRoot mismatch/);
  });

  it('prepare throws when staged guestCaBundlePath does not match opts.guestCaBundlePath (fail-closed contract)', async () => {
    const b = new WinSandboxBackend({
      sessionId: 't',
      deps: {
        ...okDeps(),
        stageCopy: async () => ({ guestSkillRoot: '/session/skill', guestCaBundlePath: '/wrong/ca.pem' }),
      } as never,
    });
    await b.probe();
    await b.prepareTopology();
    await expect(
      b.prepare({
        snapshotRoot: '/x',
        expectedSnapshotDigest: DIGEST,
        proxyAddr: 'http://127.0.0.1:8080',
        caBundlePath: '/ca.pem',
        runtimeProfile: {
          id: 'r', bins: [], path: '',
          windowsRuntime: { manifestPath: 'm', nodePath: 'n', bootstrapPath: 'b' },
        },
        guestSkillRoot: '/session/skill', guestCaBundlePath: '/session/ca.pem',
        resources: { memoryBytes: 1 << 20, cpus: 1, timeoutMs: 1000 },
      } as never),
    ).rejects.toThrow(/guestCaBundlePath mismatch/);
  });

  it('Option 3 + run-11: installGate is keyed on the session node.exe COPY (appIdPath), never a package SID or the toolchain path', async () => {
    let captured: unknown;
    const b = new WinSandboxBackend({
      sessionId: 't',
      deps: {
        ...okDeps(),
        stageCopy: async () => ({ guestSkillRoot: '/session/skill', guestCaBundlePath: '/session/ca.pem' }),
        installGate: async (req: unknown) => { captured = req; return { filterKeys: ['k'] }; },
        launchSandboxed: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        teardownSandbox: async () => {},
        removeGate: async () => {},
        removeCopyDir: async () => {},
      } as never,
    });
    await b.probe();
    await b.prepareTopology();
    await b.prepare({
      snapshotRoot: '/x',
      expectedSnapshotDigest: DIGEST,
      proxyAddr: 'http://127.0.0.1:8080',
      caBundlePath: '/ca.pem',
      runtimeProfile: {
        id: 'r', bins: [], path: '',
        windowsRuntime: { manifestPath: 'm', nodePath: 'C:\\rt\\node.exe', bootstrapPath: 'b' },
      },
      guestSkillRoot: '/session/skill', guestCaBundlePath: '/session/ca.pem',
      resources: { memoryBytes: 1 << 20, cpus: 1, timeoutMs: 1000 },
    } as never);
    const req = captured as Record<string, unknown>;
    // guestSkillRoot '/session/skill' -> sessionDir '/session' -> the staged
    // copy is path.join(sessionDir, 'node.exe') (fake stageLaunchNode mirrors
    // the default's shape). The toolchain nodePath 'C:\rt\node.exe' must NOT
    // be the key. Derive the expected value via path.join so the assertion
    // holds on Windows (backslash separators) as well as POSIX — a hardcoded
    // '/session/node.exe' literal fails on Windows ('\session\node.exe').
    expect(req.appIdPath).toBe(path.join('/session', 'node.exe'));
    expect(req.appIdPath).not.toBe('C:\\rt\\node.exe');
    expect(req).not.toHaveProperty('packageSid');
    await b.cleanup();
  });

  it('Option 3: spawn launches with restrictedToken:true (no LPAC)', async () => {
    let capturedArgs: unknown;
    const b = new WinSandboxBackend({
      sessionId: 't',
      deps: {
        ...okDeps(),
        stageCopy: async () => ({ guestSkillRoot: '/session/skill', guestCaBundlePath: '/session/ca.pem' }),
        installGate: async () => ({ filterKeys: ['k'] }),
        launchSandboxed: async (args: unknown) => {
          capturedArgs = args;
          return { exitCode: 0, stdout: '', stderr: '' };
        },
        teardownSandbox: async () => {},
        removeGate: async () => {},
        removeCopyDir: async () => {},
      } as never,
    });
    await b.probe();
    await b.prepareTopology();
    await b.prepare({
      snapshotRoot: '/x',
      expectedSnapshotDigest: DIGEST,
      proxyAddr: 'http://127.0.0.1:8080',
      caBundlePath: '/ca.pem',
      runtimeProfile: {
        id: 'r', bins: [], path: '',
        windowsRuntime: { manifestPath: 'm', nodePath: 'C:\\rt\\node.exe', bootstrapPath: 'b' },
      },
      guestSkillRoot: '/session/skill', guestCaBundlePath: '/session/ca.pem',
      resources: { memoryBytes: 1 << 20, cpus: 1, timeoutMs: 1000 },
    } as never);
    await b.run({ command: ['main.js'] } as never);
    expect((capturedArgs as Record<string, unknown>).restrictedToken).toBe(true);
    // Run-11: the helper launches the session-private node.exe copy, not the
    // host toolchain nodePath. Derive via path.join (Windows uses backslashes).
    expect((capturedArgs as Record<string, unknown>).nodePath).toBe(path.join('/session', 'node.exe'));
    await b.cleanup();
  });

  it('run-11: default stageLaunchNode copies the closure node.exe into the sessionDir and prepare keys the gate on the copy', async () => {
    // Real filesystem, cross-platform: no DI for stageLaunchNode. A source
    // 'node.exe' with sentinel bytes is staged by the backend's default
    // collaborator; the gate's appIdPath must be the copy and the copy must
    // carry the same bytes (integrity of what actually launches).
    let captured: unknown;
    const srcDir = mkdtempSync(path.join(tmpdir(), 'oct-rt-'));
    const sessionRoot = mkdtempSync(path.join(tmpdir(), 'oct-session-'));
    try {
      const srcNode = path.join(srcDir, 'node.exe');
      writeFileSync(srcNode, 'MZ-sentinel');
      const sessionDir = path.join(sessionRoot, 's');
      const b = new WinSandboxBackend({
        sessionId: 't',
        deps: {
          platform: 'win32',
          verifyRuntime: async () => true,
          probeHelper: async () => true,
          gateAvailable: async () => true,
          stageCopy: async () => ({
            guestSkillRoot: path.join(sessionDir, 'skill'),
            guestCaBundlePath: path.join(sessionDir, 'ca.pem'),
          }),
          installGate: async (req: unknown) => { captured = req; return { filterKeys: ['k'] }; },
          launchSandboxed: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
          teardownSandbox: async () => {},
          removeGate: async () => {},
          removeCopyDir: async () => {},
        } as never,
      });
      await b.probe();
      await b.prepareTopology();
      await b.prepare({
        snapshotRoot: '/x',
        expectedSnapshotDigest: DIGEST,
        proxyAddr: 'http://127.0.0.1:8080',
        caBundlePath: '/ca.pem',
        runtimeProfile: {
          id: 'r', bins: [], path: '',
          windowsRuntime: { manifestPath: 'm', nodePath: srcNode, bootstrapPath: 'b' },
        },
        guestSkillRoot: path.join(sessionDir, 'skill'),
        guestCaBundlePath: path.join(sessionDir, 'ca.pem'),
        resources: { memoryBytes: 1 << 20, cpus: 1, timeoutMs: 1000 },
      } as never);
      const copyPath = path.join(sessionDir, 'node.exe');
      expect((captured as Record<string, unknown>).appIdPath).toBe(copyPath);
      expect(existsSync(copyPath)).toBe(true);
      expect(readFileSync(copyPath, 'utf8')).toBe('MZ-sentinel');
      await b.cleanup();
    } finally {
      rmSync(srcDir, { recursive: true, force: true });
      rmSync(sessionRoot, { recursive: true, force: true });
    }
  });

  it('run-11: prepare fails closed when the node.exe copy cannot be staged', async () => {
    // If the session-private copy cannot be produced, prepare() must throw
    // BEFORE the gate install — a gate keyed on nothing, or a launch from the
    // unreachable toolchain path, would both be silently-wrong states.
    let gateCalls = 0;
    const b = new WinSandboxBackend({
      sessionId: 't',
      deps: {
        ...okDeps(),
        stageCopy: async () => ({ guestSkillRoot: '/session/skill', guestCaBundlePath: '/session/ca.pem' }),
        stageLaunchNode: async () => { throw new Error('copy failed'); },
        installGate: async () => { gateCalls++; return { filterKeys: ['k'] }; },
      } as never,
    });
    await b.probe();
    await b.prepareTopology();
    await expect(
      b.prepare({
        snapshotRoot: '/x',
        expectedSnapshotDigest: DIGEST,
        proxyAddr: 'http://127.0.0.1:8080',
        caBundlePath: '/ca.pem',
        runtimeProfile: {
          id: 'r', bins: [], path: '',
          windowsRuntime: { manifestPath: 'm', nodePath: 'n', bootstrapPath: 'b' },
        },
        guestSkillRoot: '/session/skill', guestCaBundlePath: '/session/ca.pem',
        resources: { memoryBytes: 1 << 20, cpus: 1, timeoutMs: 1000 },
      } as never),
    ).rejects.toThrow(/copy failed/);
    expect(gateCalls).toBe(0);
  });
});

describe('stageVerifiedCopy', () => {
  it('copies the snapshot + CA and re-verifies the digest', async () => {
    const src = mkdtempSync(path.join(tmpdir(), 'oct-src-'));
    const dst = mkdtempSync(path.join(tmpdir(), 'oct-dst-'));
    try {
      // Build a deterministic snapshot tree.
      mkdirSync(path.join(src, 'skill'), { recursive: true });
      writeFileSync(path.join(src, 'skill', 'main.js'), 'console.log(1)\n');
      writeFileSync(path.join(src, 'ca.pem'), 'CA\n');

      // Compute the expected digest over the SKILL subtree only (the digest
      // contract covers the snapshot skill root; the CA is content-checked).
      const { buildSnapshot } = await import('../../src/snapshot.js');
      const store = mkdtempSync(path.join(tmpdir(), 'oct-store-'));
      const built = await buildSnapshot({
        sourceDir: path.join(src, 'skill'),
        storeDir: store,
        installationId: 'inst',
        name: 'n',
        source: 'local',
      });

      const out = await stageVerifiedCopy({
        snapshotRoot: built.snapshotRoot,
        caBundlePath: path.join(src, 'ca.pem'),
        expectedDigest: built.identity.digest,
        sessionDir: dst,
      });
      expect(existsSync(out.guestSkillRoot)).toBe(true);
      expect(existsSync(out.guestCaBundlePath)).toBe(true);
      expect(existsSync(path.join(out.guestSkillRoot, 'main.js'))).toBe(true);
      rmSync(store, { recursive: true, force: true });
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dst, { recursive: true, force: true });
    }
  });

  it('throws on a digest mismatch (TOCTOU guard)', async () => {
    const src = mkdtempSync(path.join(tmpdir(), 'oct-src-'));
    const dst = mkdtempSync(path.join(tmpdir(), 'oct-dst-'));
    try {
      writeFileSync(path.join(src, 'main.js'), 'x\n');
      writeFileSync(path.join(src, 'ca.pem'), 'CA\n');
      await expect(
        stageVerifiedCopy({
          snapshotRoot: src,
          caBundlePath: path.join(src, 'ca.pem'),
          expectedDigest: DIGEST, // does not match the actual tree
          sessionDir: dst,
        }),
      ).rejects.toThrow(/digest/i);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dst, { recursive: true, force: true });
    }
  });
});

describe('WinSandboxBackend cleanup (memoized first outcome + ContainmentCleanupError)', () => {
  function preparedBackend(depOverrides: Record<string, unknown> = {}) {
    const calls: string[] = [];
    const b = new WinSandboxBackend({
      sessionId: 'sess',
      deps: {
        ...okDeps(),
        stageCopy: async () => ({ guestSkillRoot: '/session/skill', guestCaBundlePath: '/session/ca.pem' }),
        installGate: async () => { calls.push('installGate'); return { filterKeys: ['k'] }; },
        launchSandboxed: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        teardownSandbox: async () => { calls.push('teardownSandbox'); },
        removeGate: async () => { calls.push('removeGate'); },
        removeCopyDir: async () => { calls.push('removeCopyDir'); },
        ...depOverrides,
      } as never,
    });
    return { b, calls };
  }

  const PREPARE_OPTS = {
    snapshotRoot: '/x',
    expectedSnapshotDigest: DIGEST,
    proxyAddr: 'http://127.0.0.1:8080',
    caBundlePath: '/ca.pem',
    runtimeProfile: {
      id: 'r', bins: [], path: '',
      windowsRuntime: { manifestPath: 'm', nodePath: 'n', bootstrapPath: 'b' },
    },
    guestSkillRoot: '/session/skill', guestCaBundlePath: '/session/ca.pem',
    resources: { memoryBytes: 1 << 20, cpus: 1, timeoutMs: 1000 },
  } as never;

  it('runs teardown -> removeGate -> delete copy in order, and resolves clean', async () => {
    const { b, calls } = preparedBackend();
    await b.probe();
    await b.prepareTopology();
    await b.prepare(PREPARE_OPTS);
    await b.cleanup();
    const order = calls.filter((c) => ['teardownSandbox', 'removeGate', 'removeCopyDir'].includes(c));
    expect(order).toEqual(['teardownSandbox', 'removeGate', 'removeCopyDir']);
    // Idempotent + clean second call.
    await b.cleanup();
  });

  it('throws ContainmentCleanupError when the Job cannot be confirmed dead, keeps the gate, memoizes', async () => {
    const { b, calls } = preparedBackend({
      teardownSandbox: async () => { calls.push('teardownSandbox'); throw new Error('ActiveProcesses != 0'); },
    });
    await b.probe();
    await b.prepareTopology();
    await b.prepare(PREPARE_OPTS);
    let first: unknown;
    try { await b.cleanup(); } catch (e) { first = e; }
    expect(first).toBeInstanceOf(ContainmentCleanupError);
    // The gate must NOT be removed while the process may still be alive.
    expect(calls).not.toContain('removeGate');
    // Memoized first outcome: a repeat call rethrows the SAME instance.
    let second: unknown;
    try { await b.cleanup(); } catch (e) { second = e; }
    expect(second).toBe(first);
  });

  it('treats a post-death removeGate failure as SOFT (no ContainmentCleanupError), still deletes copy', async () => {
    const { b, calls } = preparedBackend({
      removeGate: async () => { calls.push('removeGate'); throw new Error('leftover block filter'); },
    });
    await b.probe();
    await b.prepareTopology();
    await b.prepare(PREPARE_OPTS);
    // Job confirmed dead (teardownSandbox ok) → leftover block filter is
    // fail-closed residue / host hygiene, NOT containment. Resolves clean.
    await b.cleanup();
    expect(calls).toContain('teardownSandbox');
    expect(calls).toContain('removeCopyDir');
    // Resolves identically on repeat.
    await b.cleanup();
  });
});

describe('WinSandboxBackend run() stdin plumbing (ExecSpec.stdin contract)', () => {
  const PREPARE_OPTS = {
    snapshotRoot: '/x',
    expectedSnapshotDigest: DIGEST,
    proxyAddr: 'http://127.0.0.1:8080',
    caBundlePath: '/ca.pem',
    runtimeProfile: {
      id: 'r', bins: [], path: '',
      windowsRuntime: { manifestPath: 'm', nodePath: 'n', bootstrapPath: 'b' },
    },
    guestSkillRoot: '/session/skill', guestCaBundlePath: '/session/ca.pem',
    resources: { memoryBytes: 1 << 20, cpus: 1, timeoutMs: 1000 },
  } as never;

  it('forwards the one-shot stdin payload to the launcher as HelperSpawnOptions.stdin', async () => {
    let capturedStdin: unknown;
    let capturedOpts: unknown;
    const b = new WinSandboxBackend({
      sessionId: 'sess',
      deps: {
        ...okDeps(),
        stageCopy: async () => ({ guestSkillRoot: '/session/skill', guestCaBundlePath: '/session/ca.pem' }),
        installGate: async () => ({ filterKeys: ['k'] }),
        // Capture the second (HelperSpawnOptions) argument.
        launchSandboxed: async (_args: unknown, opts: unknown) => {
          capturedOpts = opts;
          capturedStdin = (opts as { stdin?: unknown } | undefined)?.stdin;
          return { exitCode: 0, stdout: 'out', stderr: '' };
        },
        teardownSandbox: async () => {},
        removeGate: async () => {},
        removeCopyDir: async () => {},
      } as never,
    });
    await b.probe();
    await b.prepareTopology();
    await b.prepare(PREPARE_OPTS);

    const res = await b.run({ command: ['main.js'], stdin: 'hello-stdin-payload' } as never);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('out');
    // The payload reached the launcher (and would be written to the helper's
    // stdin by spawnHelper), NOT dropped into a readerless buffer.
    expect(capturedStdin).toBe('hello-stdin-payload');
    expect((capturedOpts as { stdin?: unknown }).stdin).toBe('hello-stdin-payload');
  });

  it('omits HelperSpawnOptions.stdin when run() has no payload', async () => {
    let capturedOpts: unknown;
    let called = false;
    const b = new WinSandboxBackend({
      sessionId: 'sess',
      deps: {
        ...okDeps(),
        stageCopy: async () => ({ guestSkillRoot: '/session/skill', guestCaBundlePath: '/session/ca.pem' }),
        installGate: async () => ({ filterKeys: ['k'] }),
        launchSandboxed: async (_args: unknown, opts: unknown) => {
          called = true;
          capturedOpts = opts;
          return { exitCode: 0, stdout: '', stderr: '' };
        },
        teardownSandbox: async () => {},
        removeGate: async () => {},
        removeCopyDir: async () => {},
      } as never,
    });
    await b.probe();
    await b.prepareTopology();
    await b.prepare(PREPARE_OPTS);
    await b.run({ command: ['main.js'] } as never);
    expect(called).toBe(true);
    // No payload → no stdin option passed (helper stdin stays a plain pipe).
    expect(capturedOpts).toBeUndefined();
  });
});

describe('spawnHelper stdin option (write + close the child stdin)', () => {
  it('writes the payload to the spawned child stdin', async () => {
    // Use node itself as a stand-in "helper" that echoes its stdin to stdout,
    // so we can assert the payload actually flowed through the stdin pipe.
    const echoScript = `
      let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{process.stdout.write(d);});
    `;
    const res = await spawnHelper(['-e', echoScript], {
      exePath: process.execPath,
      stdin: 'payload-through-stdin',
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('payload-through-stdin');
  });
});
