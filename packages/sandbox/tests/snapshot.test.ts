import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { buildSnapshot, verifySnapshot, SnapshotError } from '../src/snapshot.js';

let tmp: string;
let src: string;
let store: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'));
  src = path.join(tmp, 'src');
  store = path.join(tmp, 'store');
  fs.mkdirSync(path.join(src, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: t\n---\n');
  fs.writeFileSync(path.join(src, 'scripts', 'invoke.js'), 'console.log(1)');
});

/**
 * DEVIATION (macOS cleanup fix): Node's fs.rmSync({recursive,force}) fails with
 * ENOTEMPTY on macOS when directories are chmod'd read-only (0o555). This helper
 * restores u+w before removal. The read-only behavior in src/snapshot.ts is NOT
 * weakened — this is a test-only cleanup workaround.
 */
afterEach(() => {
  try { execSync(`chmod -R u+w "${tmp}"`, { stdio: 'ignore' }); } catch { /* best effort */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('buildSnapshot', () => {
  it('builds a content-addressed immutable snapshot with a stable digest', async () => {
    const a = await buildSnapshot({ sourceDir: src, storeDir: store, installationId: 'u1', name: 't' });
    expect(a.identity.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fs.existsSync(path.join(a.snapshotRoot, 'scripts', 'invoke.js'))).toBe(true);
    // Rebuild of identical content yields identical digest.
    const b = await buildSnapshot({ sourceDir: src, storeDir: store, installationId: 'u1', name: 't' });
    expect(b.identity.digest).toBe(a.identity.digest);
  });

  it('changes digest when content changes', async () => {
    const a = await buildSnapshot({ sourceDir: src, storeDir: store, installationId: 'u1' });
    fs.writeFileSync(path.join(src, 'scripts', 'invoke.js'), 'console.log(2)');
    const b = await buildSnapshot({ sourceDir: src, storeDir: store, installationId: 'u1' });
    expect(b.identity.digest).not.toBe(a.identity.digest);
  });

  it('rejects symlinks that escape the root', async () => {
    fs.symlinkSync('/etc/passwd', path.join(src, 'escape'));
    await expect(buildSnapshot({ sourceDir: src, storeDir: store, installationId: 'u1' }))
      .rejects.toBeInstanceOf(SnapshotError);
  });

  it('allows in-root symlinks', async () => {
    fs.mkdirSync(path.join(src, 'subdir'));
    fs.symlinkSync('subdir', path.join(src, 'oklink')); // in-root symlink is allowed
    const s = await buildSnapshot({ sourceDir: src, storeDir: store, installationId: 'u1' });
    expect(s.identity.digest).toBeDefined();
  });

  describe.skipIf(process.platform === 'win32')('special files (POSIX)', () => {
    it('rejects special files (FIFO)', async () => {
      execSync(`mkfifo "${path.join(src, 'myfifo')}"`);
      await expect(buildSnapshot({ sourceDir: src, storeDir: store, installationId: 'u1' }))
        .rejects.toBeInstanceOf(SnapshotError);
    });
  });

  it('produces a stable digest independent of locale collation (mixed-case paths)', async () => {
    // 'Zebra' and 'apple' sort differently under localeCompare (locale-sensitive)
    // vs code-unit order. The digest must be a pure function of content, so two
    // builds of the same tree must produce the same digest regardless of host
    // locale or ICU version.
    fs.mkdirSync(path.join(src, 'Zebra'));
    fs.writeFileSync(path.join(src, 'Zebra', 'x'), 'zx');
    fs.mkdirSync(path.join(src, 'apple'));
    fs.writeFileSync(path.join(src, 'apple', 'y'), 'ay');
    const a = await buildSnapshot({ sourceDir: src, storeDir: store, installationId: 'u1' });
    // Remove the staged snapshot and rebuild to prove determinism from source.
    // Snapshots are chmod read-only; restore u+w before removal (macOS guard).
    try { execSync(`chmod -R u+w "${a.snapshotRoot}"`, { stdio: 'ignore' }); } catch { /* best effort */ }
    fs.rmSync(a.snapshotRoot, { recursive: true, force: true });
    const b = await buildSnapshot({ sourceDir: src, storeDir: store, installationId: 'u1' });
    expect(b.identity.digest).toBe(a.identity.digest);
    expect(a.identity.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('verifySnapshot detects tampering after explicitly making one file writable', async () => {
    const a = await buildSnapshot({ sourceDir: src, storeDir: store, installationId: 'u1' });
    expect(await verifySnapshot(a.snapshotRoot, a.identity.digest)).toBe(true);
    const selected = path.join(a.snapshotRoot, 'scripts', 'invoke.js');
    // Snapshots are chmod read-only. The test deliberately simulates an attacker
    // with sufficient host privilege by restoring write permission before mutation.
    fs.chmodSync(selected, 0o644);
    fs.writeFileSync(selected, 'tampered');
    await expect(verifySnapshot(a.snapshotRoot, a.identity.digest)).resolves.toBe(false);
  });
});
