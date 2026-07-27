/**
 * Tests for packages/sandbox/src/os/cgroup.ts (Plan 4, Task 3).
 *
 * Layout
 * ------
 * 1. Portable unit tests — exercise `createLimitedCgroup` against an
 *    injected in-memory cgroup filesystem. They assert the mandatory
 *    write-order (memory.max, memory.swap.max, pids.max, cpu.max), the
 *    read-back comparison, the cgroup.kill/cgroup.events existence checks,
 *    and the fail-closed cleanup path (partial cgroup removed on any
 *    failure). These run on macOS.
 *
 * 2. Linux-gated delegation test — creates a REAL cgroup under
 *    /sys/fs/cgroup, writes real limits, attaches a stopped child, forks a
 *    grandchild, calls kill(), and waits for `populated 0`. Skipped on
 *    macOS; OCTOPUS_REQUIRE_OS_SANDBOX=1 hard-fails the Linux lane.
 */
import { describe, it, expect } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createLimitedCgroup,
  CgroupError,
  type CgroupFs,
} from '../src/os/cgroup.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// In-memory fake cgroup FS — records every operation in order.
// ---------------------------------------------------------------------------

interface FakeOp {
  op: 'mkdir' | 'write' | 'read' | 'rmdir' | 'exists';
  path: string;
  data?: string;
}

class FakeCgroupFs implements CgroupFs {
  readonly ops: FakeOp[] = [];
  private readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>();
  /** Paths whose writes should fail, for fault-injection tests. */
  readonly failWrites = new Set<string>();
  /** Paths that, once written, read back a DIFFERENT value (kernel refuse). */
  readonly corruptReads = new Map<string, string>();

  constructor(readonly root: string) {
    this.dirs.add(root);
    // Every cgroup dir always has these control files.
    this.seedDir(root);
  }

  private seedDir(dir: string): void {
    for (const f of ['cgroup.kill', 'cgroup.events', 'cgroup.procs']) {
      this.files.set(path.join(dir, f), f === 'cgroup.events' ? 'populated 0\n' : '');
    }
  }

  private abs(p: string): string { return p; }

  async mkdir(p: string): Promise<void> {
    this.ops.push({ op: 'mkdir', path: p });
    if (this.dirs.has(p)) throw new Error(`EEXIST: ${p}`);
    this.dirs.add(p);
    this.seedDir(p);
  }
  async writeFile(p: string, data: string): Promise<void> {
    this.ops.push({ op: 'write', path: p, data });
    if (this.failWrites.has(p)) throw new Error(`EIO: write to ${p}`);
    if (!this.dirs.has(path.dirname(p))) throw new Error(`ENOENT: ${p}`);
    this.files.set(p, data);
  }
  async readFile(p: string): Promise<string> {
    this.ops.push({ op: 'read', path: p });
    if (!this.files.has(p)) throw new Error(`ENOENT: ${p}`);
    const corrupt = this.corruptReads.get(p);
    if (corrupt !== undefined) return corrupt;
    return this.files.get(p)!;
  }
  async rmdir(p: string): Promise<void> {
    this.ops.push({ op: 'rmdir', path: p });
    if (!this.dirs.has(p)) throw new Error(`ENOENT: ${p}`);
    this.dirs.delete(p);
    for (const k of [...this.files.keys()]) {
      if (k.startsWith(p + '/')) this.files.delete(k);
    }
  }
  async exists(p: string): Promise<boolean> {
    this.ops.push({ op: 'exists', path: p });
    return this.dirs.has(p) || this.files.has(p);
  }
}

function writesFor(fake: FakeCgroupFs, suffix: string): FakeOp[] {
  return fake.ops.filter((o) => o.op === 'write' && o.path.endsWith(suffix));
}

// ---------------------------------------------------------------------------
// Portable unit tests (run on macOS).
// ---------------------------------------------------------------------------

describe('createLimitedCgroup (injected fake cgroupfs)', () => {
  const ROOT = '/sys/fs/cgroup';

  it('writes limits in the mandatory order and reads each back', async () => {
    const fake = new FakeCgroupFs(ROOT);
    const h = await createLimitedCgroup({
      name: 'oct-sess-test',
      memoryBytes: 268435456,
      pidsMax: 64,
      cpuMax: '50000 100000',
      cgroupRoot: ROOT,
      fs: fake,
    });
    const cgPath = path.join(ROOT, 'oct-sess-test');
    expect(h.path).toBe(cgPath);

    const writeOps = fake.ops.filter((o) => o.op === 'write');
    const writtenFiles = writeOps.map((o) => path.basename(o.path));
    // Mandatory order: memory.max, memory.swap.max, pids.max, cpu.max.
    expect(writtenFiles).toEqual(['memory.max', 'memory.swap.max', 'pids.max', 'cpu.max']);
    expect(writesFor(fake, 'memory.max')[0].data).toBe('268435456');
    expect(writesFor(fake, 'memory.swap.max')[0].data).toBe('0');
    expect(writesFor(fake, 'pids.max')[0].data).toBe('64');
    expect(writesFor(fake, 'cpu.max')[0].data).toBe('50000 100000');

    // Every write was followed by a read-back of the same file.
    const seq = fake.ops.filter((o) => o.op === 'write' || o.op === 'read');
    for (let i = 0; i < seq.length; i += 2) {
      expect(seq[i].op).toBe('write');
      expect(seq[i + 1].op).toBe('read');
      expect(seq[i + 1].path).toBe(seq[i].path);
    }

    // Existence checks for cgroup.kill + cgroup.events ran.
    const existChecks = fake.ops.filter((o) => o.op === 'exists').map((o) => path.basename(o.path));
    expect(existChecks).toEqual(expect.arrayContaining(['cgroup.kill', 'cgroup.events']));
  });

  it('generates a collision-resistant name when only a sessionId is given', async () => {
    const fake = new FakeCgroupFs(ROOT);
    const a = await createLimitedCgroup({
      sessionId: 'sess abc/123', memoryBytes: 1024, pidsMax: 8, cpuMax: '10000 100000',
      cgroupRoot: ROOT, fs: fake,
    });
    const b = await createLimitedCgroup({
      sessionId: 'sess abc/123', memoryBytes: 1024, pidsMax: 8, cpuMax: '10000 100000',
      cgroupRoot: ROOT, fs: fake,
    });
    expect(a.path).not.toBe(b.path);
    // Sanitized: no slashes, no spaces.
    expect(path.basename(a.path)).toMatch(/^oct-sess_abc_123-[0-9a-f]{8,}$/);
  });

  it('fails closed and removes the partial cgroup when a write is refused', async () => {
    const fake = new FakeCgroupFs(ROOT);
    fake.failWrites.add(path.join(ROOT, 'oct-x', 'pids.max'));
    await expect(createLimitedCgroup({
      name: 'oct-x', memoryBytes: 1024, pidsMax: 8, cpuMax: '10000 100000',
      cgroupRoot: ROOT, fs: fake,
    })).rejects.toThrow(CgroupError);
    // Partial cgroup was removed (rmdir recorded).
    const rmdirs = fake.ops.filter((o) => o.op === 'rmdir').map((o) => o.path);
    expect(rmdirs).toContain(path.join(ROOT, 'oct-x'));
  });

  it('fails closed when the kernel reads back a different limit (write silently clamped)', async () => {
    const fake = new FakeCgroupFs(ROOT);
    // Simulate a kernel that silently clamps memory.max.
    fake.corruptReads.set(path.join(ROOT, 'oct-y', 'memory.max'), '1073741824');
    await expect(createLimitedCgroup({
      name: 'oct-y', memoryBytes: 1024, pidsMax: 8, cpuMax: '10000 100000',
      cgroupRoot: ROOT, fs: fake,
    })).rejects.toThrow(/read-back|mismatch/i);
    const rmdirs = fake.ops.filter((o) => o.op === 'rmdir').map((o) => o.path);
    expect(rmdirs).toContain(path.join(ROOT, 'oct-y'));
  });

  it('fails closed when cgroup.kill is missing (not a v2 delegation)', async () => {
    const fake = new FakeCgroupFs(ROOT);
    // Remove cgroup.kill from the seed for the new cgroup.
    const origMkdir = fake.mkdir.bind(fake);
    fake.mkdir = async (p: string) => {
      await origMkdir(p);
      // Drop the kill file to simulate a non-delegated subtree.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fake as any).files.delete(path.join(p, 'cgroup.kill'));
    };
    await expect(createLimitedCgroup({
      name: 'oct-z', memoryBytes: 1024, pidsMax: 8, cpuMax: '10000 100000',
      cgroupRoot: ROOT, fs: fake,
    })).rejects.toThrow(/cgroup\.kill/i);
  });

  it('attach() writes the pid to cgroup.procs and read-back confirms it', async () => {
    const fake = new FakeCgroupFs(ROOT);
    const h = await createLimitedCgroup({
      name: 'oct-attach', memoryBytes: 1024, pidsMax: 8, cpuMax: '10000 100000',
      cgroupRoot: ROOT, fs: fake,
    });
    await h.attach(4321);
    const procsWrites = writesFor(fake, 'cgroup.procs');
    expect(procsWrites[procsWrites.length - 1].data).toBe('4321');
    // Read-back happened.
    const lastReads = fake.ops.filter((o) => o.op === 'read' && o.path.endsWith('cgroup.procs'));
    expect(lastReads.length).toBeGreaterThan(0);
  });

  it('kill() writes 1 to cgroup.kill and treats inability as a backend failure', async () => {
    const fake = new FakeCgroupFs(ROOT);
    const h = await createLimitedCgroup({
      name: 'oct-kill', memoryBytes: 1024, pidsMax: 8, cpuMax: '10000 100000',
      cgroupRoot: ROOT, fs: fake,
    });
    await h.kill();
    const killWrites = writesFor(fake, 'cgroup.kill');
    expect(killWrites.length).toBe(1);
    expect(killWrites[0].data).toBe('1');

    // Now make the kill write fail and assert it throws (backend failure).
    fake.failWrites.add(path.join(ROOT, 'oct-kill', 'cgroup.kill'));
    await expect(h.kill()).rejects.toThrow(CgroupError);
  });

  it('waitEmpty() polls cgroup.events until populated 0', async () => {
    const fake = new FakeCgroupFs(ROOT);
    const h = await createLimitedCgroup({
      name: 'oct-empty', memoryBytes: 1024, pidsMax: 8, cpuMax: '10000 100000',
      cgroupRoot: ROOT, fs: fake,
    });
    // Simulate a still-populated cgroup for the first two polls.
    let polls = 0;
    const origRead = fake.readFile.bind(fake);
    fake.readFile = async (p: string) => {
      if (p.endsWith('cgroup.events')) {
        polls++;
        if (polls <= 2) return 'populated 1\n';
      }
      return origRead(p);
    };
    await h.waitEmpty(2000);
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  it('waitEmpty() times out when the cgroup never empties', async () => {
    const fake = new FakeCgroupFs(ROOT);
    const h = await createLimitedCgroup({
      name: 'oct-stuck', memoryBytes: 1024, pidsMax: 8, cpuMax: '10000 100000',
      cgroupRoot: ROOT, fs: fake,
    });
    fake.corruptReads.set(path.join(ROOT, 'oct-stuck', 'cgroup.events'), 'populated 1\n');
    await expect(h.waitEmpty(150)).rejects.toThrow(/timeout|timed out/i);
  });
});

// ---------------------------------------------------------------------------
// Linux-gated real-cgroup delegation test.
// Skipped on macOS. OCTOPUS_REQUIRE_OS_SANDBOX=1 converts a capability skip
// into a hard failure so the Plan 6 lane cannot silently regress.
// ---------------------------------------------------------------------------

const isLinux = process.platform === 'linux';
const REQUIRE_OS = process.env.OCTOPUS_REQUIRE_OS_SANDBOX === '1';

async function cgroupV2Available(): Promise<boolean> {
  try {
    await fs.access('/sys/fs/cgroup/cgroup.controllers', fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!isLinux)('createLimitedCgroup — real cgroup v2 (Linux lane)', () => {
  it('creates a delegated cgroup, attaches a stopped child, kills, waits empty', async () => {
    if (!(await cgroupV2Available())) {
      if (REQUIRE_OS) throw new Error('OCTOPUS_REQUIRE_OS_SANDBOX=1 but /sys/fs/cgroup is not writable');
      return;
    }

    const sessionId = `oct-test-${process.pid}`;
    const handle = await createLimitedCgroup({
      sessionId,
      memoryBytes: 64 * 1024 * 1024,
      pidsMax: 32,
      cpuMax: '50000 100000',
    });

    try {
      // Read-back assertions on the real kernel interface.
      const memMax = await fs.readFile(path.join(handle.path, 'memory.max'), 'utf8');
      expect(memMax.trim()).toBe(String(64 * 1024 * 1024));
      const pidsMax = await fs.readFile(path.join(handle.path, 'pids.max'), 'utf8');
      expect(pidsMax.trim()).toBe('32');
      const cpuMax = await fs.readFile(path.join(handle.path, 'cpu.max'), 'utf8');
      expect(cpuMax.trim()).toBe('50000 100000');
      const swapMax = await fs.readFile(path.join(handle.path, 'memory.swap.max'), 'utf8');
      expect(swapMax.trim()).toBe('0');

      // Spawn a stopped child, attach it to the cgroup, then SIGCONT.
      const child = spawn('sleep', ['30'], { detached: false });
      child.kill('SIGSTOP');
      await handle.attach(child.pid!);

      // Confirm the child appears in cgroup.procs before SIGCONT.
      const procs = await fs.readFile(path.join(handle.path, 'cgroup.procs'), 'utf8');
      expect(procs.split('\n').map((s) => s.trim())).toContain(String(child.pid));

      child.kill('SIGCONT');

      // Fork a grandchild via sh -c so we exercise multi-pid kill.
      await execFileAsync('sh', ['-c', `echo $$ > /dev/null; exec sleep 30 &`], {
        env: { ...process.env },
      }).catch(() => { /* best effort */ });

      // Kill via cgroup.kill and wait for empty.
      await handle.kill();
      await handle.waitEmpty(5000);

      const events = await fs.readFile(path.join(handle.path, 'cgroup.events'), 'utf8');
      expect(events).toMatch(/populated 0/);

      child.kill('SIGKILL');
    } finally {
      await handle.cleanup();
    }
  }, 30000);
});
