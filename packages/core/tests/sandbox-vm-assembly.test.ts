/**
 * createVmBackend + createDefaultSandboxRunnerAsync assembly tests (Task 10).
 *
 * Native package is optional and currently incomplete (Task 13 adds the real
 * impls). Tests drive the factory through the loadNative / createVmBackend
 * seams — production call sites omit those deps.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SandboxConfigSchema,
  type SandboxConfig,
  type VmEnginePort,
  type VmImageBuilderPort,
  type VerifiedArtifact,
} from '@agentoctopus/sandbox';
import { createVmBackend, type NativeVmModule } from '../src/sandbox-vm-assembly.js';
import type { VmEngineDeps } from '@agentoctopus/sandbox-vm-native';
import { createDefaultSandboxRunnerAsync } from '../src/sandbox-runner-factory.js';
import { getConfig, resetConfig } from '../src/config-resolver.js';

function makeConfig(): SandboxConfig {
  return SandboxConfigSchema.parse({});
}

// Create dummy binaries so the assembly's existence check passes. helper,
// builder, and artifactsDir are co-located: round 5 binds the executed builder
// to the TCB-verified binary (artifactsDir/vm-image-builder) via realpath
// equality, so an artifactsDir diverging from the builder's dir is rejected.
function makeVmConfigWithDummyBinaries(): { config: SandboxConfig; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'octopus-vm-asm-'));
  const helperPath = path.join(dir, 'sandbox-vm-helper');
  const builderPath = path.join(dir, 'vm-image-builder');
  writeFileSync(helperPath, '#!/bin/sh\n');
  writeFileSync(builderPath, '#!/bin/sh\n');
  const config = SandboxConfigSchema.parse({
    vm: {
      rootfs: 'sha256:' + 'a'.repeat(64),
      helperPath,
      builderBinaryPath: builderPath,
      artifactsDir: dir,
    },
  });
  return { config, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const FAKE_ARTIFACT: VerifiedArtifact = {
  ref: 'sha256:' + 'a'.repeat(64),
  absolutePath: '/tmp/fake.img',
  manifestDigest: 'sha256:' + 'b'.repeat(64),
  size: 1,
  mode: 0o400,
};

function fakeEngine(): new () => VmEnginePort {
  return class implements VmEnginePort {
    async probe() {
      return { available: false, platform: 'unsupported' as const, reason: 'fake' };
    }
    async resolveRootfs(): Promise<VerifiedArtifact> {
      return FAKE_ARTIFACT;
    }
    async assertRootfsQualified(): Promise<void> {
      /* no-op fake */
    }
    async assertExecutablesQualified(): Promise<void> {
      /* no-op fake */
    }
    async start() {
      throw new Error('fake engine: start not implemented');
    }
    async close(): Promise<void> {
      /* no-op fake */
    }
    async getVerifiedImageBuilderPath(): Promise<string> {
      return '/fake/vm-image-builder';
    }
  };
}

function fakeImageBuilder(): new () => VmImageBuilderPort {
  return class implements VmImageBuilderPort {
    async buildSnapshotImage(): Promise<VerifiedArtifact> {
      return FAKE_ARTIFACT;
    }
    async buildSingleFileImage(): Promise<VerifiedArtifact> {
      return FAKE_ARTIFACT;
    }
  };
}

describe('createVmBackend', () => {
  it('returns unavailable when native package import fails', async () => {
    const result = await createVmBackend(makeConfig(), {
      loadNative: async () => {
        throw new Error('Cannot find module');
      },
    });
    expect(result).toEqual({
      unavailable: true,
      reason: 'native package missing',
    });
  });

  it('returns unavailable when native package is incomplete (missing constructors)', async () => {
    const incomplete: NativeVmModule = {
      // VmEngineImpl present, VmImageBuilderImpl missing
      VmEngineImpl: fakeEngine(),
    };
    const result = await createVmBackend(makeConfig(), {
      loadNative: async () => incomplete,
    });
    expect(result).toEqual({
      unavailable: true,
      reason: 'native package incomplete',
    });
  });

  it('returns unavailable when both constructors are missing', async () => {
    const result = await createVmBackend(makeConfig(), {
      loadNative: async () => ({} as NativeVmModule),
    });
    expect(result).toEqual({
      unavailable: true,
      reason: 'native package incomplete',
    });
  });

  it('returns a VmSandboxBackend when native is present with both constructors', async () => {
    const { config, cleanup } = makeVmConfigWithDummyBinaries();
    try {
      const result = await createVmBackend(config, {
        loadNative: async () => ({
          VmEngineImpl: fakeEngine(),
          VmImageBuilderImpl: fakeImageBuilder(),
          createNativeDeps: () => ({ platform: 'unsupported' } as unknown as VmEngineDeps),
        }),
      });
      expect('unavailable' in result).toBe(false);
      if (!('unavailable' in result)) {
        expect(result.kind).toBe('vm');
        expect(result.isolationLevel).toBe('full');
      }
    } finally {
      cleanup();
    }
  });

  // F1 (round 5): a builderBinaryPath that does not realpath-resolve to the
  // TCB-verified builder (artifactsDir/vm-image-builder) would execute
  // UNVERIFIED — the assembly must refuse to construct the backend.
  it('returns unavailable when builderBinaryPath diverges from the verified builder', async () => {
    const { config, cleanup } = makeVmConfigWithDummyBinaries();
    // Point the builder at a DIFFERENT real file outside artifactsDir.
    const otherDir = mkdtempSync(path.join(tmpdir(), 'octopus-vm-asm-evil-'));
    const evilBuilder = path.join(otherDir, 'vm-image-builder');
    writeFileSync(evilBuilder, '#!/bin/sh\n');
    const divergent = SandboxConfigSchema.parse({
      vm: {
        rootfs: 'sha256:' + 'a'.repeat(64),
        helperPath: (config.vm as { helperPath?: string }).helperPath,
        builderBinaryPath: evilBuilder,
        artifactsDir: (config.vm as { artifactsDir?: string }).artifactsDir,
      },
    });
    try {
      const result = await createVmBackend(divergent, {
        loadNative: async () => ({
          VmEngineImpl: fakeEngine(),
          VmImageBuilderImpl: fakeImageBuilder(),
          createNativeDeps: () => ({ platform: 'unsupported' } as unknown as VmEngineDeps),
        }),
      });
      expect('unavailable' in result).toBe(true);
      if ('unavailable' in result) {
        expect(result.reason).toMatch(/does not resolve to the TCB-verified builder/);
      }
    } finally {
      cleanup();
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  // F4: defaultPrebuildRoot() must resolve the native package's prebuilds via
  // the package graph (require.resolve), NOT the source-tree walk that resolves
  // to node_modules/packages/sandbox-vm-native (which doesn't exist) in an npm
  // install. With no explicit helperPath, the resolved helper path must point
  // at the REAL native package prebuilds dir. Two outcomes are both valid:
  //  - unavailable: the helper binary is absent from prebuilds (fresh checkout)
  //    — the reason must echo a path under sandbox-vm-native/prebuilds/<platform>
  //    (proving the resolution is correct), NOT the broken source-tree walk.
  //  - a full backend: a locally-built (gitignored) helper exists in prebuilds
  //    — kind 'vm' itself proves resolution succeeded, because the broken walk
  //    would always resolve to a nonexistent path and thus return unavailable.
  it('F4: resolves prebuilds via the package graph, not the source-tree walk', async () => {
    // No explicit helperPath/builderBinaryPath — force defaultPrebuildRoot().
    const config = SandboxConfigSchema.parse({ vm: { rootfs: 'sha256:' + 'a'.repeat(64) } });
    const result = await createVmBackend(config, {
      loadNative: async () => ({
        VmEngineImpl: fakeEngine(),
        VmImageBuilderImpl: fakeImageBuilder(),
        createNativeDeps: () => ({ platform: 'unsupported' } as unknown as VmEngineDeps),
      }),
    });
    const plat = process.platform === 'darwin' ? 'darwin-arm64'
      : process.platform === 'linux' && process.arch === 'x64' ? 'linux-x64'
      : null;
    if ('unavailable' in result) {
      // Skip on unsupported platforms (no VM prebuilds expected).
      if (plat) {
        // The reported path must be under the native package's prebuilds/<platform>
        // dir — NOT the broken node_modules/packages/sandbox-vm-native walk.
        expect(result.reason).toMatch(/sandbox-vm-native[\/\\]prebuilds[\/\\]/);
        expect(result.reason).not.toMatch(/node_modules[\/\\]packages[\/\\]sandbox-vm-native/);
      }
    } else {
      // A locally-built helper exists (gitignored prebuilds) — the resolution
      // must have produced a working backend. kind 'vm' is itself the proof:
      // the broken source-tree walk would have returned unavailable.
      expect(result.kind).toBe('vm');
    }
  });
});

describe('createDefaultSandboxRunnerAsync', () => {
  const prevHome = process.env.HOME;
  const prevXdg = process.env.XDG_CONFIG_HOME;

  beforeEach(() => {
    resetConfig();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    resetConfig();
  });

  function backendKinds(runner: object): string[] {
    // SandboxRunner keeps backends private; bracket access is the test seam.
    const backends = (runner as unknown as { backends: { kind: string }[] }).backends;
    return backends.map((b) => b.kind);
  }

  it('includes docker+os+windows when createVmBackend returns unavailable', async () => {
    expect(getConfig().sandbox).toBeDefined();

    const runner = await createDefaultSandboxRunnerAsync(undefined, {
      createVmBackend: async () => ({
        unavailable: true,
        reason: 'native package missing',
      }),
    });
    const kinds = backendKinds(runner);
    expect(kinds).toEqual(['docker', 'os', 'windows']);
    expect(kinds).not.toContain('vm');
  });

  it('includes a vm backend when createVmBackend returns a real backend', async () => {
    expect(getConfig().sandbox).toBeDefined();

    const fakeBackend = new (class {
      kind = 'vm' as const;
      isolationLevel = 'full' as const;
    })();
    const runner = await createDefaultSandboxRunnerAsync(undefined, {
      createVmBackend: async () => fakeBackend as unknown as Awaited<ReturnType<typeof createVmBackend>>,
    });
    const kinds = backendKinds(runner);
    expect(kinds).toContain('docker');
    expect(kinds).toContain('os');
    expect(kinds).toContain('vm');
  });
});
