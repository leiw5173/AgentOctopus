// packages/sandbox-vm-native/src/create-cloexec-pipe.ts
// R9 P1-1: cross-platform cloexec pipe. macOS has no pipe2, so the cloexec bit
// is set per-end (Linux pipe2(O_CLOEXEC) in one call; Darwin pipe()+fcntl).
//
// Node's child_process does NOT expose pipe2/pipe+fcntl or the raw fd table.
// createCloexecPipe therefore resolves to a tiny native binding (a `.node`
// addon or koffi FFI) that ships in `prebuilds/` and is built by
// `scripts/build-vm-helper.mjs` (Task 15). The binding returns
// `[readFd, writeFd]` (read FIRST, write SECOND — the POSIX convention the
// R9/R10 FD-plumbing section of the spec depends on), BOTH ends cloexec.
//
// This module is the seam. The real binding is injected by the engine via
// `deps.pipe`; the L1 unit test injects a fake so the FD-config logic can be
// verified without the compiled addon. Calling `createCloexecPipe()` with no
// deps (no binding resolved) throws — the real path is L3.

export interface CreateCloexecPipeDeps {
  /** Native binding: returns [readFd, writeFd], both cloexec. */
  pipe(): Promise<[number, number]> | [number, number];
}

/**
 * Create a cloexec pipe. Returns `[readFd, writeFd]`, both ends cloexec.
 * Requires a `deps.pipe` binding (the native addon). Throws if none is
 * supplied — the unit-test path injects a fake; production passes the real
 * binding resolved by the engine.
 */
export async function createCloexecPipe(
  deps: CreateCloexecPipeDeps,
): Promise<[number, number]> {
  if (!deps || typeof deps.pipe !== 'function') {
    throw new Error(
      'createCloexecPipe requires a native pipe binding (deps.pipe) — not available in unit test',
    );
  }
  return await deps.pipe();
}
