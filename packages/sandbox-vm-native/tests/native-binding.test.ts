import { describe, it, expect } from 'vitest';
import { createNativeDeps, getLibc, fdIsCloexec } from '../src/native-binding.js';

const SUPPORTED =
  (process.platform === 'darwin' && process.arch === 'arm64') ||
  (process.platform === 'linux' && process.arch === 'x64');

describe('createNativeDeps smoke', () => {
  it.skipIf(!SUPPORTED)('pipe returns two distinct cloexec fds that round-trip bytes', async () => {
    const deps = createNativeDeps();
    const [readFd, writeFd] = await deps.pipe();
    expect(readFd).toBeGreaterThanOrEqual(0);
    expect(writeFd).toBeGreaterThanOrEqual(0);
    expect(readFd).not.toBe(writeFd);

    const fs = await import('node:fs');
    const data = Buffer.from('hello koffi');
    fs.writeSync(writeFd, data);
    fs.closeSync(writeFd);
    const read = Buffer.alloc(data.length);
    const n = fs.readSync(readFd, read);
    expect(n).toBe(data.length);
    expect(read.toString()).toBe(data.toString());
    fs.closeSync(readFd);
  });

  it.skipIf(!SUPPORTED)('pipe ends have FD_CLOEXEC set (R10 contract)', async () => {
    // Review Minor #9: the cloexec property is load-bearing for the R10
    // FD-plumbing contract (engine.ts:478-494 assumes the dup'd fds are
    // cloexec). Assert via fcntl(F_GETFD) — NOT just a byte round-trip.
    const libc = getLibc();
    const deps = createNativeDeps();
    const [readFd, writeFd] = await deps.pipe();
    expect(fdIsCloexec(libc, readFd)).toBe(true);
    expect(fdIsCloexec(libc, writeFd)).toBe(true);
    const fs = await import('node:fs');
    fs.closeSync(readFd);
    fs.closeSync(writeFd);
  });

  it.skipIf(!SUPPORTED)('dupFdCloexec returns a fresh cloexec fd >= min', async () => {
    // Review Minor #9: the duplicated fd must be >= min AND cloexec.
    const libc = getLibc();
    const deps = createNativeDeps();
    const [readFd, writeFd] = await deps.pipe();
    const dup = await deps.dupFdCloexec(readFd, 20);
    expect(dup).toBeGreaterThanOrEqual(20);
    expect(dup).not.toBe(readFd);
    expect(fdIsCloexec(libc, dup)).toBe(true);
    const fs = await import('node:fs');
    fs.closeSync(readFd);
    fs.closeSync(writeFd);
    fs.closeSync(dup);
  });

  it.skipIf(!SUPPORTED)(
    'spawn bridges real stdout via dup2 file action (koffi struct identity proof)',
    async () => {
      // Review Critical #1 + Important #3: prove the file_actions struct
      // backing buffer is shared across init → adddup2 → posix_spawn (i.e.
      // the adddup2 we register actually takes effect in the child). Spawn
      // /bin/sh -c 'echo MARKER' with a file action that dup2's a pipe
      // write-end into fd 1; read the marker back via raw.stdout.
      const deps = createNativeDeps();
      // We rely on the binding to append its own stdout/stderr pipe + adddup2
      // actions, so we pass NO file actions and read from raw.stdout.
      const raw = await deps.spawn(
        '/bin/sh',
        ['sh', '-c', 'echo spawn-marker-ok'],
        { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        [],
        [],
        [],
      );
      const chunks: Buffer[] = [];
      for await (const chunk of raw.stdout as AsyncIterable<Buffer>) {
        chunks.push(chunk);
      }
      const out = Buffer.concat(chunks).toString('utf8');
      expect(out).toContain('spawn-marker-ok');
      const status = await raw.exited;
      expect(status.exitCode).toBe(0);
      expect(status.timedOut).toBe(false);
    },
    10_000,
  );

  it.skipIf(!SUPPORTED)(
    'spawn exited/kill/close resolve cleanly on a long-running child',
    async () => {
      const deps = createNativeDeps();
      const raw = await deps.spawn(
        '/bin/sh',
        ['sh', '-c', 'sleep 30'],
        { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        [],
        [],
        [],
      );
      // Give the child a moment to start, then kill it.
      await new Promise((r) => setTimeout(r, 100));
      await raw.kill();
      const status = await raw.exited;
      // SIGKILL → exit code 128 + 9 = 137 (or 0 if already reaped — ECHILD path).
      expect([137, 0]).toContain(status.exitCode);
      // close() must resolve (idempotent kill + cleanup).
      await raw.close();
    },
    5_000,
  );
});
