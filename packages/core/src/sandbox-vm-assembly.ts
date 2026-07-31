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
import { existsSync } from 'node:fs';
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
  const tcbManifestPath = vm?.tcbManifestPath ?? path.join(prebuilds, 'vm-tcb-manifest.json');
  const gateManifestPath = vm?.gateManifestPath ?? path.join(prebuilds, 'gate-manifest.json');
  // Default the detached release-manifest pair to the prebuilds dir so a
  // shipped native package is verified end-to-end with no extra config. The
  // producer (sign-release-manifest.mjs) writes exactly these two filenames.
  // If neither exists (dev box, unsigned dev build), engine.probe() sees
  // haveReleaseManifest=false → 'missing' (soft, capability probe stays up).
  const releaseManifestPath = vm?.releaseManifestPath ?? path.join(prebuilds, 'release-manifest.json');
  const releaseManifestSignaturePath = vm?.releaseManifestSignaturePath ?? path.join(prebuilds, 'release-manifest.json.sig');
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
      // webpackIgnore: the VM backend is a runtime-only OPTIONAL native package
      // (libkrun microVM for macOS/Linux hosts). Turbopack (Next.js web app)
      // would otherwise statically resolve this dynamic-import specifier and
      // bundle koffi's native `.node` binding — a "non-ecmascript placeable
      // asset" that fails the web build. serverExternalPackages cannot
      // externalize a dynamic-import() specifier. This comment makes Turbopack
      // skip bundling and leave the import as-is: in plain Node (CLI, gateway)
      // it resolves normally; in the web app's serverless runtime the import
      // throws and the catch below returns the fail-closed `unavailable` path —
      // exactly what the web app already does (it never selects the VM backend).
      // Harmless to tsc: removeComments is unset, so the comment survives to
      // dist/ where Turbopack reads it.
      (await import(/* webpackIgnore: true */ '@agentoctopus/sandbox-vm-native')) as NativeVmModule);

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

  // Fail-closed (review Important #10): if the resolved helper binary or
  // builder binary does not exist on disk, return { unavailable } rather than
  // handing back a backend whose probe()/start() would throw a confusing
  // "file not found" later. This is especially load-bearing for an installed
  // @agentoctopus/core where defaultPrebuildRoot() (assembly.ts:42-48) walks
  // up from import.meta.url and resolves wrong in node_modules — the
  // existence check converts that silent mis-resolution into a clean
  // unavailable reason instead of a half-wired backend.
  if (!existsSync(engineOpts.helperPath)) {
    return {
      unavailable: true,
      reason: `VM helper binary not found at ${engineOpts.helperPath} (set sandbox.vm.helperPath)`,
    };
  }

  const prebuilds = defaultPrebuildRoot();
  const resolvedBuilderPath = config.vm?.builderBinaryPath ?? path.join(prebuilds, 'vm-image-builder');
  if (!existsSync(resolvedBuilderPath)) {
    return {
      unavailable: true,
      reason: `VM image-builder binary not found at ${resolvedBuilderPath} (set sandbox.vm.builderBinaryPath)`,
    };
  }

  const engine: VmEnginePort = new native.VmEngineImpl(engineOpts, native.createNativeDeps());
  const imageBuilder: VmImageBuilderPort = new native.VmImageBuilderImpl(resolvedBuilderPath);
  return new VmSandboxBackend({ config, engine, imageBuilder });
}
