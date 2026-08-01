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
import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  VmSandboxBackend,
  type SandboxConfig,
  type VmEnginePort,
  type VmImageBuilderPort,
} from '@agentoctopus/sandbox';
import type { VmEngineOptions } from '@agentoctopus/sandbox-vm-native';

/** Minimal surface of the optional native package we construct against. */
export type NativeVmModule = {
  VmEngineImpl?: new (opts: VmEngineOptions, deps: unknown) => VmEnginePort & {
    getVerifiedImageBuilderPath(): Promise<string>;
  };
  VmImageBuilderImpl?: new (builderBinaryPath?: string | (() => Promise<string>)) => VmImageBuilderPort;
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

/**
 * Resolve the native package's `prebuilds/<platform>` directory.
 *
 * Two resolution paths, in order:
 *
 *  1. Package-graph resolve (installed npm consumers): resolve
 *     `@agentoctopus/sandbox-vm-native/package.json` via Node's require
 *     resolver, which walks `node_modules` the same way `import` does. The
 *     prebuilds ship in the published tarball (`files: [..., "prebuilds"]`),
 *     so `path.dirname(resolvedPkgJson)/prebuilds/<platform>` is the correct
 *     installed location regardless of how deep `@agentoctopus/core` is nested.
 *
 *  2. Source-tree walk (monorepo dev only): `core`'s source lives at
 *     `packages/core/src/`, so walking up from `import.meta.url` reaches
 *     `packages/sandbox-vm-native/prebuilds`. This path is WRONG in an npm
 *     install (`node_modules/@agentoctopus/core/dist/` → `node_modules/packages/…`),
 *     so it is only a fallback for when the package-graph resolve fails —
 *     i.e. the native package isn't installed as a dependency, which is the
 *     monorepo-dev case (workspace symlinks make the graph resolve succeed too,
 *     so in practice the fallback only fires for unusual layouts).
 *
 * Returns `null` if neither path resolves — `buildEngineOpts` then throws and
 * `createVmBackend` returns `{ unavailable }` fail-closed.
 */
function defaultPrebuildRoot(): string | null {
  const platform = resolveVmPlatform();
  if (platform === 'unsupported') return null;

  // (1) Package-graph resolve.
  try {
    const require = createRequire(import.meta.url);
    const pkgJsonPath = require.resolve('@agentoctopus/sandbox-vm-native/package.json');
    return path.join(path.dirname(pkgJsonPath), 'prebuilds', platform);
  } catch {
    // native package not resolvable as a dependency — fall through to the
    // source-tree walk (monorepo dev).
  }

  // (2) Source-tree walk (monorepo dev fallback).
  const currentFile = fileURLToPath(import.meta.url);
  const coreSrc = path.dirname(currentFile);
  const pkgRoot = path.resolve(coreSrc, '..', '..', '..', 'packages', 'sandbox-vm-native');
  const prebuilds = path.join(pkgRoot, 'prebuilds', platform);
  return existsSync(prebuilds) ? prebuilds : null;
}

function buildEngineOpts(config: SandboxConfig): VmEngineOptions {
  const platform = resolveVmPlatform();
  if (platform === 'unsupported') {
    throw new Error('createVmBackend: unsupported host platform for VM backend');
  }
  const prebuilds = defaultPrebuildRoot();
  if (!prebuilds) {
    throw new Error(
      'createVmBackend: could not resolve @agentoctopus/sandbox-vm-native prebuilds directory ' +
      '(neither the installed package nor the monorepo source tree provided one); ' +
      'set sandbox.vm.helperPath / builderBinaryPath explicitly',
    );
  }
  const vm = config.vm;
  const helperPath = vm?.helperPath ?? path.join(prebuilds, 'sandbox-vm-helper');
  const artifactsDir = vm?.artifactsDir ?? prebuilds;
  const tcbManifestPath = vm?.tcbManifestPath ?? path.join(prebuilds, 'vm-tcb-manifest.json');
  const gateManifestPath = vm?.gateManifestPath ?? path.join(prebuilds, 'gate-manifest.json');
  // Default the detached release-manifest pair to the prebuilds dir so a
  // shipped native package is verified end-to-end with no extra config. The
  // producer (sign-release-manifest.mjs) writes exactly these two filenames.
  // requireReleaseSignature:true makes ABSENCE fail closed — production
  // assembly is a release build, so a missing signature pair means a tampered
  // install, not a dev box. This compiled-in flag is the unremovable "release
  // build" marker: deleting both files cannot roll an install back to unsigned
  // dev mode. The soft 'missing' degradation survives only where engine opts
  // are built WITHOUT the flag (dev boxes, the vm-lane CI harness).
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
    requireReleaseSignature: true,
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
  // "file not found" later. defaultPrebuildRoot() resolves the native package
  // through the package graph (installed npm consumers) or the monorepo source
  // tree (dev) — the existence check converts a missing prebuild into a clean
  // unavailable reason instead of a half-wired backend.
  if (!existsSync(engineOpts.helperPath)) {
    return {
      unavailable: true,
      reason: `VM helper binary not found at ${engineOpts.helperPath} (set sandbox.vm.helperPath)`,
    };
  }

  // Derive the builder path from the SAME resolved prebuilds dir as the helper
  // (engineOpts.helperPath's dirname) so the two binaries always come from one
  // consistent location — never a second package-graph resolve that could
  // disagree with the first.
  const builderDefault = path.join(path.dirname(engineOpts.helperPath), 'vm-image-builder');
  const resolvedBuilderPath = config.vm?.builderBinaryPath ?? builderDefault;
  if (!existsSync(resolvedBuilderPath)) {
    return {
      unavailable: true,
      reason: `VM image-builder binary not found at ${resolvedBuilderPath} (set sandbox.vm.builderBinaryPath)`,
    };
  }

  // EXECUTION-PATH BINDING (F1): the builder that executes must be the binary
  // the engine's probe() verifies (artifactsDir/vm-image-builder). An
  // independently configured builderBinaryPath that resolves elsewhere would
  // execute UNVERIFIED — reject it (realpath equality) instead of constructing
  // a backend whose prepare() shells out to an untrusted binary.
  const expectedBuilderPath = path.join(engineOpts.artifactsDir, 'vm-image-builder');
  const [resolvedBuilderReal, expectedBuilderReal] = await Promise.all([
    realpath(resolvedBuilderPath).catch(() => null),
    realpath(expectedBuilderPath).catch(() => null),
  ]);
  if (!resolvedBuilderReal || !expectedBuilderReal || resolvedBuilderReal !== expectedBuilderReal) {
    return {
      unavailable: true,
      reason: `VM builderBinaryPath (${resolvedBuilderPath}) does not resolve to the TCB-verified builder (${expectedBuilderPath}) — refusing to exec an unverified binary`,
    };
  }

  const engine = new native.VmEngineImpl(engineOpts, native.createNativeDeps());
  // Lazy resolver: the executed builder path is resolved from the engine's
  // probe()-verified state at execution time (its engine-private copy), never
  // from the independently configured path.
  const imageBuilder: VmImageBuilderPort = new native.VmImageBuilderImpl(
    () => engine.getVerifiedImageBuilderPath(),
  );
  return new VmSandboxBackend({ config, engine, imageBuilder });
}
