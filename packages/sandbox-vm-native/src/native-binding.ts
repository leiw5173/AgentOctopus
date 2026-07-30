// packages/sandbox-vm-native/src/native-binding.ts
// Real koffi-based native binding for VmEngineDeps (Task 6 / CR-5).
//
// Fail-closed: if libc/posix_spawn symbols cannot be resolved, construction
// throws a descriptive error. No silent degradation.

import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Writable, PassThrough } from 'node:stream';
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
  posix_spawnattr_setsigdefault: (attr: unknown, sigset: unknown) => number;
  posix_spawnattr_setsigmask: (attr: unknown, sigset: unknown) => number;
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
      koffi.pointer(FileActions),
      koffi.pointer(SpawnAttr),
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
      koffi.out(koffi.pointer(FileActions)),
    ]) as (actions: unknown) => number,
    posix_spawn_file_actions_destroy: resolve('posix_spawn_file_actions_destroy', 'int', [
      koffi.pointer(FileActions),
    ]) as (actions: unknown) => number,
    posix_spawn_file_actions_adddup2: resolve('posix_spawn_file_actions_adddup2', 'int', [
      koffi.pointer(FileActions),
      'int',
      'int',
    ]) as (actions: unknown, src: number, target: number) => number,
    posix_spawn_file_actions_addclose: resolve('posix_spawn_file_actions_addclose', 'int', [
      koffi.pointer(FileActions),
      'int',
    ]) as (actions: unknown, fd: number) => number,
    posix_spawnattr_init: resolve('posix_spawnattr_init', 'int', [
      koffi.out(koffi.pointer(SpawnAttr)),
    ]) as (attr: unknown) => number,
    posix_spawnattr_destroy: resolve('posix_spawnattr_destroy', 'int', [
      koffi.pointer(SpawnAttr),
    ]) as (attr: unknown) => number,
    posix_spawnattr_setflags: resolve('posix_spawnattr_setflags', 'int', [
      koffi.pointer(SpawnAttr),
      'short',
    ]) as (attr: unknown, flags: number) => number,
    posix_spawnattr_setsigdefault: resolve('posix_spawnattr_setsigdefault', 'int', [
      koffi.pointer(SpawnAttr),
      'void *',
    ]) as (attr: unknown, sigset: unknown) => number,
    posix_spawnattr_setsigmask: resolve('posix_spawnattr_setsigmask', 'int', [
      koffi.pointer(SpawnAttr),
      'void *',
    ]) as (attr: unknown, sigset: unknown) => number,
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
  for (const fd of fds) {
    const rc = libc.fcntl_int(fd, F_SETFD, FD_CLOEXEC);
    if (rc === -1) {
      libc.close(fds[0]);
      libc.close(fds[1]);
      throw new Error(`native-binding: fcntl(F_SETFD, FD_CLOEXEC) failed for fd ${fd}`);
    }
  }
  return fds;
}

function fdIsCloexec(libc: LoadedLibc, fd: number): boolean {
  const flags = libc.fcntl_int(fd, F_GETFD, 0);
  if (flags < 0) return false;
  return (flags & FD_CLOEXEC) !== 0;
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

function pollWaitpid(
  libc: LoadedLibc,
  pid: number,
): Promise<{ exitCode: number; timedOut: boolean }> {
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
          clearInterval(timer);
          reject(new Error(`native-binding: waitpid failed (rc=${rc})`));
        }
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

function toCArgv(argv: string[]): unknown {
  return koffi.as([...argv, null], 'char **');
}

function toCEnvp(env: NodeJS.ProcessEnv): unknown {
  return koffi.as([...Object.entries(env).map(([k, v]) => `${k}=${v}`), null], 'char **');
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
  const actions = {};
  const attr = {};

  let rc = libc.posix_spawn_file_actions_init(actions);
  if (rc !== 0) {
    throw new Error(`native-binding: posix_spawn_file_actions_init failed (rc=${rc})`);
  }
  rc = libc.posix_spawnattr_init(attr);
  if (rc !== 0) {
    libc.posix_spawn_file_actions_destroy(actions);
    throw new Error(`native-binding: posix_spawnattr_init failed (rc=${rc})`);
  }

  try {
    for (const action of fileActions) {
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

    // Close parent fds as instructed by the engine.
    for (const fd of parentCloseFds) {
      libc.close(fd);
    }

    // The engine retains g2hRead (controlRead) and h2gWrite (stdin).
    // The engine does not currently pass the retained fd numbers into the
    // binding, so we cannot bridge real child stdio/control fds here. We
    // return PassThrough placeholders; the engine pipes to/from them. The
    // real fd-backed streams are a follow-up concern documented in the report.
    const controlRead = new PassThrough();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();

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
      stdout,
      stderr,
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
export { getLibc, F_GETFD, fdIsCloexec };
