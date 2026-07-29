/**
 * VM sandbox backend assembly (Task 10).
 *
 * Dynamically imports `@agentoctopus/sandbox-vm-native` as an optional
 * dependency of core. The leaf package `@agentoctopus/sandbox` never imports
 * the native package — wiring lives here so missing/incomplete native fails
 * closed to `{ unavailable: true, reason }` rather than crashing the process.
 */
import {
  VmSandboxBackend,
  type SandboxConfig,
  type VmEnginePort,
  type VmImageBuilderPort,
} from '@agentoctopus/sandbox';

/** Minimal surface of the optional native package we construct against. */
export type NativeVmModule = {
  VmEngineImpl?: new () => VmEnginePort;
  VmImageBuilderImpl?: new () => VmImageBuilderPort;
};

export type CreateVmBackendDeps = {
  /**
   * Test-only seam for the dynamic import. Production call sites omit this
   * and load `@agentoctopus/sandbox-vm-native` via `import()`.
   */
  loadNative?: () => Promise<NativeVmModule>;
};

export type VmBackendUnavailable = { unavailable: true; reason: string };

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
    typeof native.VmImageBuilderImpl !== 'function'
  ) {
    return { unavailable: true, reason: 'native package incomplete' };
  }

  const engine: VmEnginePort = new native.VmEngineImpl();
  const imageBuilder: VmImageBuilderPort = new native.VmImageBuilderImpl();
  return new VmSandboxBackend({ config, engine, imageBuilder });
}
