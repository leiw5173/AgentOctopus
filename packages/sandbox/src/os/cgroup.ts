/**
 * Plan 4, Task 3 — fail-closed cgroup v2 limits for the OS backend.
 *
 * `createLimitedCgroup()` creates a per-session cgroup v2, writes finite
 * memory/pids/cpu limits, reads each one back and compares, and verifies the
 * `cgroup.kill` + `cgroup.events` delegation files exist. ANY failure removes
 * the partial cgroup and throws — there is no best-effort mode.
 *
 * The mandatory order is:
 *   1. Create the session cgroup with a collision-resistant name
 *      (sanitized sessionId + random suffix).
 *   2. Write finite `memory.max`, `memory.swap.max=0`, `pids.max`, `cpu.max`;
 *      read each value back and compare. Verify `cgroup.kill` and
 *      `cgroup.events` exist.
 *   3. (Caller) spawns the verified helper with `--stop-before-exec`.
 *   4. `attach(pid)` writes the actual helper child PID to `cgroup.procs`,
 *      reads `cgroup.procs` back and requires that PID, then the caller
 *      sends SIGCONT.
 *   5. On any failure, `kill()` + `waitEmpty()` + remove the cgroup and
 *      surface the failure. Never continue unconfined.
 *
 * `kill()` writes `1` to `cgroup.kill` and treats inability to do so as a
 * backend failure. A process-group `child.kill()` may be used only after
 * cgroup kill to reap the trusted launcher; it is not the security boundary
 * and must never permit a `full` result.
 *
 * DI seam: all filesystem operations go through the `CgroupFs` interface.
 * Production callers get the default real-fs implementation; unit tests
 * inject an in-memory fake so the write-order and fail-closed cleanup can
 * be exercised on any host (macOS included). The real path is always used
 * in production — the seam is never consulted for behavior, only for I/O.
 *
 * Leaf-package rule: Node stdlib only.
 */

import crypto from 'node:crypto';
import { access, mkdir, readFile, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class CgroupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CgroupError';
  }
}

// ---------------------------------------------------------------------------
// DI seam — minimal, type-safe, never consulted for behavior.
// ---------------------------------------------------------------------------

export interface CgroupFs {
  mkdir(p: string): Promise<void>;
  writeFile(p: string, data: string): Promise<void>;
  readFile(p: string): Promise<string>;
  rmdir(p: string): Promise<void>;
  exists(p: string): Promise<boolean>;
}

const realCgroupFs: CgroupFs = {
  async mkdir(p) { await mkdir(p, { recursive: false }); },
  async writeFile(p, data) { await writeFile(p, data, 'utf8'); },
  async readFile(p) { return readFile(p, 'utf8'); },
  async rmdir(p) { await rmdir(p); },
  async exists(p) {
    try { await access(p); return true; } catch { return false; }
  },
};

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface CgroupHandle {
  /** Absolute path of the session cgroup (e.g. `/sys/fs/cgroup/oct-...`). */
  readonly path: string;
  /**
   * Write `pid` to `cgroup.procs`, then read `cgroup.procs` back and require
   * that PID to be present. Throws if the write or read-back fails.
   */
  attach(pid: number): Promise<void>;
  /**
   * Write `1` to `cgroup.kill`. Inability to do so is a backend failure and
   * throws. A process-group kill may follow only to reap the trusted
   * launcher; it is never the security boundary.
   */
  kill(): Promise<void>;
  /** Poll `cgroup.events` until `populated 0` or `timeoutMs` elapses. */
  waitEmpty(timeoutMs: number): Promise<void>;
  /** Remove the (now-empty) cgroup. Idempotent. */
  cleanup(): Promise<void>;
}

export interface CreateLimitedCgroupOptions {
  /**
   * Exact cgroup name. Mutually exclusive with `sessionId`. Use this when
   * the caller has already produced a collision-resistant name.
   */
  name?: string;
  /**
   * Session identifier to derive a collision-resistant name from. The name
   * is `oct-<sanitized-sessionId>-<8 random hex>`. Mutually exclusive with
   * `name`.
   */
  sessionId?: string;
  /** Hard memory ceiling in bytes (written to `memory.max`). */
  memoryBytes: number;
  /** PID ceiling (written to `pids.max`). */
  pidsMax: number;
  /** CPU bandwidth ceiling, e.g. `'50000 100000'` (written to `cpu.max`). */
  cpuMax: string;
  /** Cgroup v2 mount root. Defaults to `/sys/fs/cgroup`. */
  cgroupRoot?: string;
  /** Injectable filesystem seam. Defaults to the real fs. */
  fs?: CgroupFs;
}

// ---------------------------------------------------------------------------
// Name derivation
// ---------------------------------------------------------------------------

function sanitizeSessionId(sessionId: string): string {
  // Keep alphanumerics, dash, underscore; replace everything else with '_'.
  const s = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
  return s.length > 0 ? s.slice(0, 48) : 'anon';
}

function deriveName(sessionId: string): string {
  return `oct-${sanitizeSessionId(sessionId)}-${crypto.randomBytes(6).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create the session cgroup and write/read-back all limits. Any failure
 * removes the partial cgroup and throws a `CgroupError`.
 */
export async function createLimitedCgroup(
  opts: CreateLimitedCgroupOptions,
): Promise<CgroupHandle> {
  const fs = opts.fs ?? realCgroupFs;
  const root = opts.cgroupRoot ?? '/sys/fs/cgroup';

  if (opts.name && opts.sessionId) {
    throw new CgroupError('pass either name or sessionId, not both');
  }
  if (!opts.name && !opts.sessionId) {
    throw new CgroupError('pass one of name or sessionId');
  }
  const name = opts.name ?? deriveName(opts.sessionId!);
  if (name.includes('/') || name.includes('..')) {
    throw new CgroupError(`cgroup name must not contain '/' or '..': ${name}`);
  }
  if (!Number.isFinite(opts.memoryBytes) || opts.memoryBytes <= 0) {
    throw new CgroupError(`memoryBytes must be a positive finite number, got ${opts.memoryBytes}`);
  }
  if (!Number.isInteger(opts.pidsMax) || opts.pidsMax <= 0) {
    throw new CgroupError(`pidsMax must be a positive integer, got ${opts.pidsMax}`);
  }
  if (!/^\d+ \d+$/.test(opts.cpuMax)) {
    throw new CgroupError(`cpuMax must be '<quota> <period>', got '${opts.cpuMax}'`);
  }

  const cgPath = path.join(root, name);

  // Cleanup helper: kill, wait empty (best-effort), remove. Never throws.
  const teardown = async (): Promise<void> => {
    try { await fs.writeFile(path.join(cgPath, 'cgroup.kill'), '1'); } catch { /* may not exist */ }
    // Best-effort empty wait — the security boundary already failed; this is
    // just hygiene before rmdir.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        const ev = await fs.readFile(path.join(cgPath, 'cgroup.events'));
        if (/^populated 0$/m.test(ev)) break;
      } catch { break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    try { await fs.rmdir(cgPath); } catch { /* best-effort */ }
  };

  // ------------------------------------------------------------------
  // Step 1: create the session cgroup.
  // ------------------------------------------------------------------
  try {
    await fs.mkdir(cgPath);
  } catch (err) {
    throw new CgroupError(`cannot create cgroup ${cgPath}: ${(err as Error).message}`, { cause: err });
  }

  try {
    // ------------------------------------------------------------------
    // Step 2: write finite limits, read each back, compare.
    // Mandatory order: memory.max, memory.swap.max, pids.max, cpu.max.
    // ------------------------------------------------------------------
    const limits: Array<{ file: string; value: string }> = [
      { file: 'memory.max', value: String(opts.memoryBytes) },
      { file: 'memory.swap.max', value: '0' },
      { file: 'pids.max', value: String(opts.pidsMax) },
      { file: 'cpu.max', value: opts.cpuMax },
    ];
    for (const { file, value } of limits) {
      const p = path.join(cgPath, file);
      await fs.writeFile(p, value).catch((err) => {
        throw new CgroupError(`cannot write ${file}: ${(err as Error).message}`, { cause: err });
      });
      const readBack = (await fs.readFile(p)).trim();
      if (readBack !== value) {
        throw new CgroupError(
          `${file} read-back mismatch: wrote '${value}', kernel reports '${readBack}' — refusing to continue unconfined`,
        );
      }
    }

    // Verify the delegation files exist. Without cgroup.kill there is no
    // atomic kill; without cgroup.events there is no empty-wait.
    for (const f of ['cgroup.kill', 'cgroup.events']) {
      if (!(await fs.exists(path.join(cgPath, f)))) {
        throw new CgroupError(`${f} is missing in ${cgPath} — not a delegated cgroup v2 subtree`);
      }
    }
  } catch (err) {
    await teardown();
    if (err instanceof CgroupError) throw err;
    throw new CgroupError(`createLimitedCgroup failed: ${(err as Error).message}`, { cause: err });
  }

  // ------------------------------------------------------------------
  // Handle
  // ------------------------------------------------------------------
  let cleanedUp = false;

  const handle: CgroupHandle = {
    path: cgPath,

    async attach(pid: number): Promise<void> {
      if (!Number.isInteger(pid) || pid <= 0) {
        throw new CgroupError(`attach: pid must be a positive integer, got ${pid}`);
      }
      const procsPath = path.join(cgPath, 'cgroup.procs');
      // Attach is the security gate that confines the (SIGSTOPped, pre-exec)
      // helper child before it is continued. Node's spawn() hands back a pid the
      // instant fork returns, but the kernel cgroup membership of a freshly
      // spawned, self-stopped child can take a moment to settle on a busy host;
      // a single write+immediate read-back can transiently miss the pid even
      // though the helper is alive and stop-pending. Retry the write+read-back
      // on a short bounded budget so a transient settle delay does not abort the
      // run, while remaining FAIL-CLOSED: if the pid never lands in the leaf
      // (helper genuinely exited / refused), we still throw and never SIGCONT.
      const maxAttempts = 10;
      const delayMs = 25;
      let lastWriteErr: Error | undefined;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          await fs.writeFile(procsPath, String(pid));
          lastWriteErr = undefined;
        } catch (err) {
          lastWriteErr = err as Error;
        }
        // Read-back: the kernel must report the pid present.
        const procs = await fs.readFile(procsPath).catch(() => '');
        const pids = procs.split('\n').map((s) => s.trim()).filter(Boolean);
        if (pids.includes(String(pid))) return;
        if (attempt + 1 < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      if (lastWriteErr) {
        throw new CgroupError(`cannot attach pid ${pid} to ${cgPath}: ${lastWriteErr.message}`, { cause: lastWriteErr });
      }
      throw new CgroupError(
        `cgroup.procs read-back does not contain pid ${pid} after ${maxAttempts} attach attempts — refusing to continue unconfined`,
      );
    },

    async kill(): Promise<void> {
      // Inability to write cgroup.kill is a backend failure. There is no
      // fallback; the caller must surface this and never report `full`.
      await fs.writeFile(path.join(cgPath, 'cgroup.kill'), '1').catch((err) => {
        throw new CgroupError(
          `cannot write cgroup.kill in ${cgPath}: ${(err as Error).message} — backend failure`,
          { cause: err },
        );
      });
    },

    async waitEmpty(timeoutMs: number): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      const eventsPath = path.join(cgPath, 'cgroup.events');
      for (;;) {
        let ev: string;
        try {
          ev = await fs.readFile(eventsPath);
        } catch (err) {
          throw new CgroupError(`cannot read cgroup.events: ${(err as Error).message}`, { cause: err });
        }
        if (/^populated 0$/m.test(ev)) return;
        if (Date.now() >= deadline) {
          throw new CgroupError(
            `timeout waiting for ${cgPath} to empty after ${timeoutMs}ms (cgroup.events: ${ev.trim()})`,
          );
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    },

    async cleanup(): Promise<void> {
      if (cleanedUp) return;
      cleanedUp = true;
      // cleanup() assumes the cgroup is already empty (kill+waitEmpty ran).
      // It is idempotent and best-effort — the security boundary was kill().
      try { await fs.rmdir(cgPath); } catch { /* already gone or still populated */ }
    },
  };

  return handle;
}
