/**
 * VM sandbox backend assembly (Task 10 + Task 6 CR-5).
 *
 * Dynamically imports `@agentoctopus/sandbox-vm-native` as an optional
 * dependency of core. The leaf package `@agentoctopus/sandbox` never imports
 * the native package — wiring lives here so missing/incomplete native fails
 * closed to `{ unavailable: true, reason }` rather than crashing the process.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VmSandboxBackend,
  type SandboxConfig,
  type VmEnginePort,
  type VmImageBuilderPort,
} from '@agentoctopus/sandbox';
import type { VmEngineOptions } from '@agentoctopus/sandbox-vm-native';

/** Minimal surface of the optional native package we construct against. */
export type NativeVmModule = {
  VmEngineImpl?: new (opts: VmEngineOptions, deps: unknown) => VmEnginePort;
  VmImageBuilderImpl?: new (builderBinaryPath?: string) => VmImageBuilderPort;
  createNativeDeps?: () => unknown;
};

export type CreateVmBackendDeps = {
  /**
   * Test-only seam for the dynamic import. Production call sites omit this
   * and load `@agentoctopus/sandbox-vm-native` via `import()`.
   */
  loadNative?: () => Promise<NativeVmModule>;
};

export type VmBackendUnavailable = { unavailable: true; reason: string };

function resolveVmPlatform(): 'darwin-arm64' | 'linux-x64' | 'unsupported' {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64';
  return 'unsupported';
}

function defaultPrebuildRoot(): string {
  // packages/sandbox-vm-native/prebuilds/<platform>
  const currentFile = fileURLToPath(import.meta.url);
  const coreSrc = path.dirname(currentFile);
  const pkgRoot = path.resolve(coreSrc, '..', '..', '..', 'packages', 'sandbox-vm-native');
  return path.join(pkgRoot, 'prebuilds', resolveVmPlatform());
}

function buildEngineOpts(config: SandboxConfig): VmEngineOptions {
  const platform = resolveVmPlatform();
  if (platform === 'unsupported') {
    throw new Error('createVmBackend: unsupported host platform for VM backend');
  }
  const prebuilds = defaultPrebuildRoot();
  const vm = config.vm;
  const helperPath = vm?.helperPath ?? path.join(prebuilds, 'sandbox-vm-helper');
  const artifactsDir = vm?.artifactsDir ?? prebuilds;
  const tcbManifestPath = vm?.tcbManifestPath ?? path.join(prebuilds, 'sandbox-vm-helper.manifest.json');
  const gateManifestPath = vm?.gateManifestPath ?? path.join(prebuilds, 'gate-manifest.json');
  const releaseManifestPath = vm?.releaseManifestPath;
  const releaseManifestSignaturePath = vm?.releaseManifestSignaturePath;
  const rootfsDir = vm?.rootfsDir ?? path.join(prebuilds, 'rootfs');
  return {
    helperPath,
    artifactsDir,
    tcbManifestPath,
    gateManifestPath,
    releaseManifestPath,
    releaseManifestSignaturePath,
    rootfsDir,
  };
}

/**
 * Assemble a VmSandboxBackend when the optional native package is present and
 * complete. Fail-closed: missing import or missing constructors return
 * `{ unavailable: true, reason }` — never a half-wired backend.
 */
export async function createVmBackend(
  config: SandboxConfig,
  deps?: CreateVmBackendDeps,
): Promise<VmSandboxBackend | VmBackendUnavailable> {
  const load =
    deps?.loadNative ??
    (async () =>
      (await import('@agentoctopus/sandbox-vm-native')) as NativeVmModule);

  let native: NativeVmModule;
  try {
    native = await load();
  } catch {
    return { unavailable: true, reason: 'native package missing' };
  }

  if (
    typeof native.VmEngineImpl !== 'function' ||
    typeof native.VmImageBuilderImpl !== 'function' ||
    typeof native.createNativeDeps !== 'function'
  ) {
    return { unavailable: true, reason: 'native package incomplete' };
  }

  let engineOpts: VmEngineOptions;
  try {
    engineOpts = buildEngineOpts(config);
  } catch (err) {
    return {
      unavailable: true,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const prebuilds = defaultPrebuildRoot();
  const resolvedBuilderPath = config.vm?.builderBinaryPath ?? path.join(prebuilds, 'vm-image-builder');

  const engine: VmEnginePort = new native.VmEngineImpl(engineOpts, native.createNativeDeps());
  const imageBuilder: VmImageBuilderPort = new native.VmImageBuilderImpl(resolvedBuilderPath);
  return new VmSandboxBackend({ config, engine, imageBuilder });
}
