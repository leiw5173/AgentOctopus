// packages/sandbox-vm-native/src/native-binding.ts
// Real koffi-based native binding for VmEngineDeps (Task 6 / CR-5).
//
// Fail-closed: if libc/posix_spawn symbols cannot be resolved, construction
// throws a descriptive error. No silent degradation.
//
// Stream ownership (Approach A, post-review; krun-stdio stdio relay):
//   - controlRead (g2hRead) is owned by the ENGINE, which created it via
//     deps.pipe() and retains it. The engine overrides raw.controlRead with an
//     fd-backed stream in start() BEFORE waitForReady() — see engine.ts. The
//     binding returns a throw-on-use placeholder (tagged with
//     `__octopusNeedsEngineOverride`) so accidental early access fails loudly.
//   - stdin/stdout/stderr are owned by the BINDING and returned as real
//     fd-backed streams. stdout/stderr: two cloexec pipes, write ends dup2'd to
//     child fd1/fd2 (read ends returned; write ends added to parentCloseFds so
//     they see EOF on exit). stdin: the host end of the krun-stdio port's input
//     pipe (consInWrite, child end dup2'd to STDIO_IN_FD). The guest workload's
//     stdio rides the "krun-stdio" named virtio-console port the helper
//     registers on (STDIO_IN_FD, STDIO_OUT_FD): guest write -> STDOUT pipe ->
//     raw.stdout; host write to raw.stdin -> the workload's stdin. The engine
//     keeps these streams as-is (no override marker), so vm.stdin/vm.stdout map
//     straight through to the workload.

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

// Child fd slots for the guest workload stdio relay. The VM helper registers a
// named virtio-console port ("krun-stdio") on these fds, and the guest's
// octopus-vm-init dup2's that port onto the workload's fd 0/1/2 — so workload
// stdio rides the named port to the host: guest write -> fd STDIO_OUT_FD -> the
// stdout pipe -> raw.stdout -> vm.stdout; host write to raw.stdin (consInWrite)
// -> child fd STDIO_IN_FD -> the workload's stdin. Must match vm-helper.c
// STDIO_OUT_FD/STDIO_IN_FD and its mass_close watermark. A named port is used
// because krun_start_enter "takes over stdin/stdout" (libkrun.h): the implicit
// console's output cannot be sunk to fd 1, nor to any /dev/fd/N via
// krun_set_console_output (verified: the bytes are dropped), whereas a named
// multiport-console port on real pipe fds relays reliably — proven by the
// octopus-control ready frame reaching the host on fds 3/4.
const STDIO_OUT_FD = 6;
const STDIO_IN_FD = 7;

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
  // Workload stdin relay pipe: the guest reads the krun-stdio port's input from
  // consInRead (dup2'd into the child at STDIO_IN_FD); the parent keeps
  // consInWrite and returns it as raw.stdin.
  const [consInRead, consInWrite] = cloexecPipe(libc);

  // Append the stdio file actions to the engine-supplied list. We copy the
  // array rather than mutating the caller's (the engine may reuse it).
  //
  // The workload's stdio reaches the host via the "krun-stdio" named
  // virtio-console port, which the helper registers on (input=STDIO_IN_FD,
  // output=STDIO_OUT_FD): guest write -> fd STDIO_OUT_FD (a second alias of the
  // stdout pipe write end) -> raw.stdout -> vm.stdout; host write to raw.stdin
  // -> child fd STDIO_IN_FD (consInRead) -> the workload's stdin. A named port
  // is required because krun_start_enter takes over fd 0/1 (libkrun.h), so the
  // implicit console cannot be sunk to fd 1 — and krun_set_console_output to a
  // /dev/fd/N alias drops the bytes too (verified twice). A named multiport
  // port on real pipe fds relays reliably (the octopus-control ready frame on
  // fds 3/4 proves it). The helper's mass_close watermark must keep fds 6/7.
  const allActions: SpawnFileAction[] = [
    ...fileActions,
    { kind: 'adddup2', src: stdoutWrite, target: 1 },
    { kind: 'adddup2', src: stderrWrite, target: 2 },
    { kind: 'adddup2', src: stdoutWrite, target: STDIO_OUT_FD },
    { kind: 'adddup2', src: consInRead, target: STDIO_IN_FD },
  ];

  // The parent must close the child-owned ends after spawn so the parent's read
  // ends see EOF when the helper exits (and the stdin pipe isn't held open
  // twice). Merge with the engine-supplied parentCloseFds.
  const allParentCloseFds = [...parentCloseFds, stdoutWrite, stderrWrite, consInRead];

  const actions = {};
  const attr = {};

  let rc = libc.posix_spawn_file_actions_init(actions);
  if (rc !== 0) {
    libc.close(stdoutRead); libc.close(stdoutWrite);
    libc.close(stderrRead); libc.close(stderrWrite);
    libc.close(consInRead); libc.close(consInWrite);
    throw new Error(`native-binding: posix_spawn_file_actions_init failed (rc=${rc})`);
  }
  rc = libc.posix_spawnattr_init(attr);
  if (rc !== 0) {
    libc.posix_spawn_file_actions_destroy(actions);
    libc.close(stdoutRead); libc.close(stdoutWrite);
    libc.close(stderrRead); libc.close(stderrWrite);
    libc.close(consInRead); libc.close(consInWrite);
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

    // controlRead is owned by the ENGINE (it created g2hRead and overrides
    // raw.controlRead with an fd-backed stream in start() before waitForReady).
    // Return a throw-on-use sentinel here so any accidental access before the
    // override fails loudly rather than silently hanging on an empty stream.
    //
    // We tag the sentinel with a non-enumerable `__octopusNeedsEngineOverride`
    // property so the engine can detect it and override ONLY when the binding
    // expects it — the L1 fake returns a real working PassThrough for
    // controlRead (its fds are fake numbers), so the engine must NOT clobber
    // that. The production binding sets this marker; fakes don't.
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

    // raw.stdin is a REAL fd-backed stream (the host end of the krun-stdio
    // port's input pipe) — NOT a sentinel, and NOT tagged with the override
    // marker. The engine therefore keeps it as-is, so writes to vm.stdin reach
    // the guest workload's stdin via the named port. (The old design routed
    // vm.stdin to the host->guest control pipe; the control channel carries
    // only ready/error frames, so workload stdin belongs on the krun-stdio
    // port instead.)
    const stdin = fdToWritable(consInWrite);

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
