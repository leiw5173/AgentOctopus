// packages/sandbox-vm-native/src/native-binding.ts
// Real koffi-based native binding for VmEngineDeps (Task 6 / CR-5).
//
// Fail-closed: if libc/posix_spawn symbols cannot be resolved, construction
// throws a descriptive error. No silent degradation.
//
// Stream ownership (Approach A, post-review):
//   - controlRead (g2hRead) + stdin (h2gWrite) are owned by the ENGINE, which
//     created them via deps.pipe() and retains them. The engine overrides
//     raw.controlRead/raw.stdin with fd-backed streams in start() BEFORE
//     waitForReady() — see engine.ts. The binding returns throw-on-use
//     placeholders for those two slots so any accidental access fails loudly.
//   - stdout/stderr are owned by the BINDING: it creates two cloexec pipes,
//     appends adddup2(writeEnd → fd1/fd2) file actions, keeps the read ends,
//     and returns fd-backed Readables. The write ends are added to
//     parentCloseFds so the parent closes them after spawn (otherwise the
//     read ends never see EOF).

import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import koffi from 'koffi';
import type { SpawnFileAction, VmEngineDeps, VmInstanceRaw } from './engine.js';

// koffi's TypeSpec is not exported; silence the resolve() arg list with any.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KoffiTypeSpec = any;

const F_GETFD = 1;
const F_SETFD = 2;
// macOS F_DUPFD_CLOEXEC == 67 (verified against SDK sys/fcntl.h).
// Linux F_DUPFD_CLOEXEC == 1030. We resolve at runtime via platform switch.
const F_DUPFD_CLOEXEC_DARWIN = 67;
const F_DUPFD_CLOEXEC_LINUX = 1030;
const FD_CLOEXEC = 1;

const O_CLOEXEC = 0x80000; // Linux; not used on Darwin

// Darwin spawn attr flags (from <spawn.h>)
const POSIX_SPAWN_CLOEXEC_DEFAULT = 0x0400;

// waitpid options
const WNOHANG = 1;

const SIGKILL = 9;

// Child fd slot that aliases the stdout pipe write end, used by the VM helper
// as the libkrun implicit-console output sink ("/dev/fd/6"). Must match
// vm-helper.c CONSOLE_OUT_FD and its mass_close watermark. fd 1 cannot be used
// because krun_start_enter takes over stdin/stdout (see spawnWithLibc).
const CONSOLE_OUT_FD = 6;

const PLATFORM: VmEngineDeps['platform'] =
  process.platform === 'darwin' && process.arch === 'arm64'
    ? 'darwin-arm64'
    : process.platform === 'linux' && process.arch === 'x64'
      ? 'linux-x64'
      : 'unsupported';

const F_DUPFD_CLOEXEC = PLATFORM === 'linux-x64' ? F_DUPFD_CLOEXEC_LINUX : F_DUPFD_CLOEXEC_DARWIN;

function libcPath(): string {
  if (process.platform === 'darwin') {
    // libSystem.B.dylib is the canonical libc-equivalent on macOS.
    return '/usr/lib/libSystem.B.dylib';
  }
  if (process.platform === 'linux') {
    return 'libc.so.6';
  }
  throw new Error(`native-binding: unsupported platform ${process.platform}/${process.arch}`);
}

// Koffi-managed opaque structs for posix_spawn state. Sizing:
// macOS posix_spawn_file_actions_t/posix_spawnattr_t are small structs
// (~80-200 bytes). Linux glibc's are larger (~1000+ bytes). We over-allocate
// with a 2048-byte blob and pass it by pointer; the C functions treat it as
// opaque storage. This avoids needing platform-specific struct layouts.
//
// Struct identity (review Important #3) — the load-bearing subtlety: koffi
// marshals a plain JS object passed to a struct-pointer arg by COPYING the
// struct bytes through the object per call. `_Out_` allocates a fresh buffer
// and copies OUT (to the object) after the call; `_In_` copies IN (from the
// object) and discards the buffer. State therefore survives across calls ONLY
// if every call that MUTATES the struct is declared `_Inout_` (copy-in,
// mutate, copy-out), so the next call's copy-in sees it.
//
// This is invisible on macOS, where posix_spawn_file_actions_t is a POINTER
// to heap state (the struct bytes only hold the pointer, so even a copied
// struct refers to the same heap list). glibc's posix_spawn_file_actions_t /
// posix_spawnattr_t are INLINE — the actions ARE the struct bytes — so an
// `_Out_`-init + `_In_`-adddup2 chain silently drops the adddup2 (the buffer
// with the mutation is discarded) and posix_spawn sees an empty action list.
// The spawn integration test (`spawn bridges real stdout via dup2 file
// action`) is the load-bearing proof end-to-end on both platforms.
const FileActions = koffi.struct('FileActions', { bytes: koffi.array('uint8_t', 2048) });
const SpawnAttr = koffi.struct('SpawnAttr', { bytes: koffi.array('uint8_t', 2048) });
const pid_t = koffi.alias('pid_t', 'int');

interface LoadedLibc {
  pipe: () => [number, number];
  pipe2: (pipefd: number[], flags: number) => number;
  fcntl_int: (fd: number, cmd: number, arg: number) => number;
  close: (fd: number) => number;
  posix_spawn: (
    pid: number[],
    path: string,
    fileActions: unknown,
    attr: unknown,
    argv: unknown,
    envp: unknown,
  ) => number;
  posix_spawn_file_actions_init: (actions: unknown) => number;
  posix_spawn_file_actions_destroy: (actions: unknown) => number;
  posix_spawn_file_actions_adddup2: (actions: unknown, src: number, target: number) => number;
  posix_spawn_file_actions_addclose: (actions: unknown, fd: number) => number;
  posix_spawnattr_init: (attr: unknown) => number;
  posix_spawnattr_destroy: (attr: unknown) => number;
  posix_spawnattr_setflags: (attr: unknown, flags: number) => number;
  waitpid: (pid: number, status: number[], options: number) => number;
  kill: (pid: number, sig: number) => number;
}

function loadLibc(): LoadedLibc {
  const lib = koffi.load(libcPath());

  const resolve = (name: string, result: string, args: KoffiTypeSpec[]) => {
    try {
      return lib.func(name, result, args);
    } catch (err) {
      throw new Error(
        `native-binding: failed to resolve ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const pipe_fn = resolve('pipe', 'int', ['_Out_ int *']) as (pipefd: number[]) => number;
  const pipe2_fn =
    PLATFORM === 'linux-x64'
      ? (resolve('pipe2', 'int', ['_Out_ int *', 'int']) as (pipefd: number[], flags: number) => number)
      : undefined;

  return {
    pipe: () => {
      const fds: number[] = [0, 0];
      const rc = pipe_fn(fds);
      if (rc !== 0) {
        throw new Error(`native-binding: pipe() failed (rc=${rc})`);
      }
      return [fds[0], fds[1]] as [number, number];
    },
    pipe2: pipe2_fn
      ? (pipefd, flags) => {
          if (!pipe2_fn) throw new Error('native-binding: pipe2 not available');
          return pipe2_fn(pipefd, flags);
        }
      : () => {
          throw new Error('native-binding: pipe2 not available on this platform');
        },
    fcntl_int: resolve('__fcntl', 'int', ['int', 'int', 'int']) as (fd: number, cmd: number, arg: number) => number,
    close: resolve('close', 'int', ['int']) as (fd: number) => number,
    posix_spawn: resolve('posix_spawn', 'int', [
      koffi.out(koffi.pointer(pid_t)),
      'str',
      koffi.inout(koffi.pointer(FileActions)),
      koffi.inout(koffi.pointer(SpawnAttr)),
      'void *',
      'void *',
    ]) as (
      pid: number[],
      path: string,
      fileActions: unknown,
      attr: unknown,
      argv: unknown,
      envp: unknown,
    ) => number,
    posix_spawn_file_actions_init: resolve('posix_spawn_file_actions_init', 'int', [
      // _Inout_, NOT _Out_: init MUTATES the struct bytes (the resulting
      // action list must survive to the subsequent adddup2/addclose calls).
      // _Out_ copies out to a fresh buffer and the mutation would be lost —
      // fatal on glibc where the actions are inline struct bytes.
      koffi.inout(koffi.pointer(FileActions)),
    ]) as (actions: unknown) => number,
    posix_spawn_file_actions_destroy: resolve('posix_spawn_file_actions_destroy', 'int', [
      koffi.inout(koffi.pointer(FileActions)),
    ]) as (actions: unknown) => number,
    posix_spawn_file_actions_adddup2: resolve('posix_spawn_file_actions_adddup2', 'int', [
      // _Inout_, NOT _In_: the adddup2 mutation must be copied back into the
      // JS object so the NEXT call (the final posix_spawn) copies it IN again.
      // With _In_ the mutation is discarded after the call — silently dropping
      // the dup2 on glibc (inline struct state). macOS masks this because its
      // file_actions_t is a heap pointer.
      koffi.inout(koffi.pointer(FileActions)),
      'int',
      'int',
    ]) as (actions: unknown, src: number, target: number) => number,
    posix_spawn_file_actions_addclose: resolve('posix_spawn_file_actions_addclose', 'int', [
      koffi.inout(koffi.pointer(FileActions)),
      'int',
    ]) as (actions: unknown, fd: number) => number,
    posix_spawnattr_init: resolve('posix_spawnattr_init', 'int', [
      koffi.inout(koffi.pointer(SpawnAttr)),
    ]) as (attr: unknown) => number,
    posix_spawnattr_destroy: resolve('posix_spawnattr_destroy', 'int', [
      koffi.inout(koffi.pointer(SpawnAttr)),
    ]) as (attr: unknown) => number,
    posix_spawnattr_setflags: resolve('posix_spawnattr_setflags', 'int', [
      koffi.inout(koffi.pointer(SpawnAttr)),
      'short',
    ]) as (attr: unknown, flags: number) => number,
    waitpid: resolve('waitpid', 'pid_t', ['pid_t', '_Out_ int *', 'int']) as (
      pid: number,
      status: number[],
      options: number,
    ) => number,
    kill: resolve('kill', 'int', ['pid_t', 'int']) as (pid: number, sig: number) => number,
  };
}

let cachedLibc: LoadedLibc | undefined;

function getLibc(): LoadedLibc {
  if (!cachedLibc) cachedLibc = loadLibc();
  return cachedLibc;
}

function setCloexec(libc: LoadedLibc, fd: number): void {
  const rc = libc.fcntl_int(fd, F_SETFD, FD_CLOEXEC);
  if (rc === -1) {
    libc.close(fd);
    throw new Error(`native-binding: fcntl(F_SETFD, FD_CLOEXEC) failed for fd ${fd}`);
  }
}

export function fdIsCloexec(libc: LoadedLibc, fd: number): boolean {
  const flags = libc.fcntl_int(fd, F_GETFD, 0);
  if (flags < 0) return false;
  return (flags & FD_CLOEXEC) !== 0;
}

function cloexecPipeLinux(libc: LoadedLibc): [number, number] {
  const fds: number[] = [0, 0];
  const rc = libc.pipe2(fds, O_CLOEXEC);
  if (rc !== 0) {
    throw new Error(`native-binding: pipe2(O_CLOEXEC) failed (rc=${rc})`);
  }
  return [fds[0], fds[1]];
}

function cloexecPipeDarwin(libc: LoadedLibc): [number, number] {
  const fds = libc.pipe();
  for (const fd of fds) setCloexec(libc, fd);
  return fds;
}

/** Cross-platform cloexec pipe (used internally for stdout/stderr bridging). */
function cloexecPipe(libc: LoadedLibc): [number, number] {
  return PLATFORM === 'linux-x64' ? cloexecPipeLinux(libc) : cloexecPipeDarwin(libc);
}

function fdToReadable(fd: number): Readable {
  // fs.createReadStream with an integer fd auto-closes the fd when the stream
  // is destroyed unless autoClose:false. We keep fd ownership with the
  // VmInstanceRaw lifecycle, so disable autoClose.
  return createReadStream('', { fd, autoClose: false });
}

function fdToWritable(fd: number): Writable {
  return createWriteStream('', { fd, autoClose: false });
}

// Exported for the VM gate script (run-vm-gates.mjs), which spawns the helper
// directly via deps.spawn and must wrap its retained control fds (g2hRead /
// h2gWrite) into streams to read the guest console — the same plumbing the
// engine performs internally. NOT part of the leaf public surface (index.ts).
export { fdToReadable, fdToWritable };

function pollWaitpid(
  libc: LoadedLibc,
  pid: number,
): Promise<{ exitCode: number; timedOut: boolean }> {
  // Review Important #5: a rc < 0 from waitpid is ECHILD (child already
  // reaped by init / already waited on). For a security sandbox that means
  // the child is GONE — treat that as success (resolve with exitCode 0)
  // rather than rejecting, so kill()/close() don't surface a spurious error
  // and the caller can't be fooled into thinking the child may still run.
  // Keep reject only for thrown exceptions (genuine call failure).
  return new Promise((resolve, reject) => {
    const status: number[] = [0];
    const timer = setInterval(() => {
      try {
        const rc = libc.waitpid(pid, status, WNOHANG);
        if (rc === pid) {
          clearInterval(timer);
          const raw = status[0];
          const signal = raw & 0x7f;
          const exitCode = signal !== 0 ? 128 + signal : (raw >> 8) & 0xff;
          resolve({ exitCode, timedOut: false });
        } else if (rc < 0) {
          // ECHILD or similar — child already reaped; treat as already-dead.
          clearInterval(timer);
          resolve({ exitCode: 0, timedOut: false });
        }
        // rc === 0 → child still running; keep polling.
      } catch (err) {
        clearInterval(timer);
        reject(err);
      }
    }, 20);
    // Ensure the poll does not keep the event loop alive if the caller drops
    // the VmInstance without awaiting exited.
    timer.unref();
  });
}

/**
 * Reject any string containing a NUL byte. koffi's 'str'/'char **' encoding
 * silently truncates at the first NUL (verified: `getenv('FOO\0BAR')`
 * returns the value of `FOO`, not null) — for argv/envp that is a fail-closed
 * violation (a malicious `OCTOPUS_VSOCK_HOST_SOCKET` containing `\0` would
 * be silently truncated and could redirect the vsock bridge). Reject up front.
 */
function rejectNul(s: string, label: string): void {
  if (s.includes('\0')) {
    throw new Error(`native-binding: ${label} contains a NUL byte (refusing to truncate)`);
  }
}

function toCArgv(argv: string[]): unknown {
  for (const a of argv) rejectNul(a, 'argv element');
  return koffi.as([...argv, null], 'char **');
}

function toCEnvp(env: NodeJS.ProcessEnv): unknown {
  const entries: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    const entry = `${k}=${v}`;
    rejectNul(entry, `env entry ${k}`);
    entries.push(entry);
  }
  entries.push(''); // sentinel placeholder; replaced by null below
  return koffi.as([...entries.slice(0, -1), null], 'char **');
}

function spawnWithLibc(
  libc: LoadedLibc,
  helperPath: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
  fileActions: SpawnFileAction[],
  spawnAttrFlags: string[],
  parentCloseFds: number[],
  platform: VmEngineDeps['platform'],
): VmInstanceRaw {
  // Two cloexec pipes for stdout/stderr bridging. The write ends are dup2'd
  // into the child's fd1/fd2 via appended file actions; the parent keeps the
  // read ends and returns them as the raw.stdout/raw.stderr streams.
  const [stdoutRead, stdoutWrite] = cloexecPipe(libc);
  const [stderrRead, stderrWrite] = cloexecPipe(libc);

  // Append the stdio file actions to the engine-supplied list. We copy the
  // array rather than mutating the caller's (the engine may reuse it).
  //
  // fd CONSOLE_OUT_FD (6) is a SECOND alias of the stdout pipe write end. The
  // helper points libkrun's implicit-console output at "/dev/fd/6" so guest
  // workload stdio reaches raw.stdout (-> vm.stdout). It CANNOT use fd 1:
  // krun_start_enter "takes over stdin/stdout" (libkrun.h), so a console sink
  // on fd 1 resolves back into the VMM's own console bridge and is dropped
  // (verified: empty helper stdout). fd 6 is untouched by that takeover, and
  // both the gate and the engine already read raw.stdout, so no extra bridging
  // is needed on either side. The helper's mass_close watermark must keep fd 6.
  const allActions: SpawnFileAction[] = [
    ...fileActions,
    { kind: 'adddup2', src: stdoutWrite, target: 1 },
    { kind: 'adddup2', src: stderrWrite, target: 2 },
    { kind: 'adddup2', src: stdoutWrite, target: CONSOLE_OUT_FD },
  ];

  // The parent must close the write ends after spawn so the read ends see EOF
  // when the helper exits. Merge with the engine-supplied parentCloseFds.
  const allParentCloseFds = [...parentCloseFds, stdoutWrite, stderrWrite];

  const actions = {};
  const attr = {};

  let rc = libc.posix_spawn_file_actions_init(actions);
  if (rc !== 0) {
    libc.close(stdoutRead); libc.close(stdoutWrite);
    libc.close(stderrRead); libc.close(stderrWrite);
    throw new Error(`native-binding: posix_spawn_file_actions_init failed (rc=${rc})`);
  }
  rc = libc.posix_spawnattr_init(attr);
  if (rc !== 0) {
    libc.posix_spawn_file_actions_destroy(actions);
    libc.close(stdoutRead); libc.close(stdoutWrite);
    libc.close(stderrRead); libc.close(stderrWrite);
    throw new Error(`native-binding: posix_spawnattr_init failed (rc=${rc})`);
  }

  try {
    for (const action of allActions) {
      if (action.kind === 'adddup2') {
        rc = libc.posix_spawn_file_actions_adddup2(actions, action.src, action.target);
        if (rc !== 0) {
          throw new Error(
            `native-binding: posix_spawn_file_actions_adddup2(${action.src}, ${action.target}) failed (rc=${rc})`,
          );
        }
      } else if (action.kind === 'addclose') {
        rc = libc.posix_spawn_file_actions_addclose(actions, action.fd);
        if (rc !== 0) {
          throw new Error(
            `native-binding: posix_spawn_file_actions_addclose(${action.fd}) failed (rc=${rc})`,
          );
        }
      }
    }

    let flags = 0;
    if (platform === 'darwin-arm64' && spawnAttrFlags.includes('POSIX_SPAWN_CLOEXEC_DEFAULT')) {
      flags |= POSIX_SPAWN_CLOEXEC_DEFAULT;
    }
    if (flags !== 0) {
      rc = libc.posix_spawnattr_setflags(attr, flags);
      if (rc !== 0) {
        throw new Error(`native-binding: posix_spawnattr_setflags(${flags}) failed (rc=${rc})`);
      }
    }

    const pid: number[] = [0];
    rc = libc.posix_spawn(pid, helperPath, actions, attr, toCArgv(argv), toCEnvp(env));
    if (rc !== 0) {
      throw new Error(`native-binding: posix_spawn('${helperPath}') failed (rc=${rc})`);
    }

    // Close parent fds as instructed (engine's + our stdio write ends).
    for (const fd of allParentCloseFds) {
      libc.close(fd);
    }

    // controlRead/stdin are owned by the ENGINE (it created g2hRead/h2gWrite
    // and overrides raw.controlRead/raw.stdin with fd-backed streams in
    // start() before waitForReady). Return throw-on-use sentinels here so
    // any accidental access before the override fails loudly rather than
    // silently hanging on an empty PassThrough.
    //
    // We tag the sentinels with a non-enumerable `__octopusNeedsEngineOverride`
    // property so the engine can detect them and override ONLY when the
    // binding expects it — the L1 fake returns a real working PassThrough
    // for controlRead/stdin (its fds are fake numbers), so the engine must
    // NOT clobber those. The production binding sets this marker; fakes don't.
    const controlRead = new Readable({
      read() {
        throw new Error(
          'native-binding: controlRead must be overridden by the engine (g2hRead fd-backed stream)',
        );
      },
    });
    Object.defineProperty(controlRead, '__octopusNeedsEngineOverride', {
      value: true,
      enumerable: false,
    });
    const stdin = new Writable({
      write(_chunk, _enc, cb) {
        cb(new Error(
          'native-binding: stdin must be overridden by the engine (h2gWrite fd-backed stream)',
        ));
      },
    });
    Object.defineProperty(stdin, '__octopusNeedsEngineOverride', {
      value: true,
      enumerable: false,
    });

    const exited = pollWaitpid(libc, pid[0]);

    let killed = false;
    const kill = async (): Promise<void> => {
      if (killed) return;
      killed = true;
      libc.kill(pid[0], SIGKILL);
      await exited.catch(() => {});
    };

    const close = async (): Promise<void> => {
      await kill();
    };

    return {
      stdin,
      stdout: fdToReadable(stdoutRead),
      stderr: fdToReadable(stderrRead),
      controlRead,
      exited,
      kill,
      close,
    };
  } finally {
    libc.posix_spawn_file_actions_destroy(actions);
    libc.posix_spawnattr_destroy(attr);
  }
}

export function createNativeDeps(): VmEngineDeps {
  if (PLATFORM === 'unsupported') {
    return {
      platform: 'unsupported',
      pipe: () => {
        throw new Error('native-binding: unsupported platform');
      },
      dupFdCloexec: () => {
        throw new Error('native-binding: unsupported platform');
      },
      spawn: () => {
        throw new Error('native-binding: unsupported platform');
      },
    };
  }

  const libc = getLibc();

  return {
    platform: PLATFORM,
    pipe: () => (PLATFORM === 'linux-x64' ? cloexecPipeLinux(libc) : cloexecPipeDarwin(libc)),
    dupFdCloexec: (src, min) => {
      const fd = libc.fcntl_int(src, F_DUPFD_CLOEXEC, min);
      if (fd < 0) {
        throw new Error(`native-binding: fcntl(F_DUPFD_CLOEXEC, ${min}) failed (fd=${fd})`);
      }
      return fd;
    },
    spawn: (helperPath, argv, env, fileActions, spawnAttrFlags, parentCloseFds) =>
      spawnWithLibc(libc, helperPath, argv, env, fileActions, spawnAttrFlags, parentCloseFds, PLATFORM),
  };
}

// Re-export for tests/consumers that want to inspect the resolved libc object.
export { getLibc, F_GETFD };
