// packages/sandbox-vm-native/tests/vm-image-builder.test.ts
// L1 test for vm-image-builder: invokes the compiled C binary directly via
// execFile against fixture trees. The binary is the TOCTOU-closed ext4 writer;
// these tests exercise its descriptor-relative traversal security guarantees
// (R4 P1-2) plus digest-mismatch fail-closed behavior.
//
// The binary is gitignored (built reproducibly by scripts/ — Task 15 owns the
// production build script). Tests skip when OCTOPUS_VM_IMAGE_BUILDER is unset
// so `pnpm test` stays green on a clean checkout (no compiled binary present).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, symlink, link, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Set OCTOPUS_VM_IMAGE_BUILDER=<abs path to compiled binary> to run these.
// Empty => skip (clean-checkout friendly).
const BUILDER = process.env.OCTOPUS_VM_IMAGE_BUILDER ?? '';
const itIfBuilt = BUILDER ? it : it.skip;

// The C builder computes the canonical snapshot digest during copy and asserts
// it == the expected digest passed on argv. A deliberately-wrong expected digest
// therefore drives the mismatch/fail-closed path for ANY non-empty tree.
const WRONG_DIGEST = 'sha256:' + '0'.repeat(64);

async function mkTree(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vm-ib-'));
}

describe('vm-image-builder (C, requires built binary)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkTree();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  itIfBuilt('rejects symlinks at open (O_NOFOLLOW) — no symlink breakout', async () => {
    await writeFile(join(dir, 'real'), 'x');
    await symlink('real', join(dir, 'link'));
    // O_NOFOLLOW on the entry name => ELOOP => builder die()s, output deleted.
    await expect(
      exec(BUILDER, ['snapshot', dir, WRONG_DIGEST, join(dir, 'out.img')]),
    ).rejects.toThrow();
    // Fail-closed: no partial output left behind.
    await expect(stat(join(dir, 'out.img'))).rejects.toThrow();
  });

  itIfBuilt('rejects hardlinks for regular files (st_nlink > 1)', async () => {
    await writeFile(join(dir, 'f'), 'x');
    await link(join(dir, 'f'), join(dir, 'f2'));
    await expect(
      exec(BUILDER, ['snapshot', dir, WRONG_DIGEST, join(dir, 'out.img')]),
    ).rejects.toThrow();
    await expect(stat(join(dir, 'out.img'))).rejects.toThrow();
  });

  itIfBuilt('on digest mismatch deletes output and fails (fail closed)', async () => {
    // A single regular file with a wrong expected digest: traversal succeeds,
    // but the recomputed canonical digest != WRONG_DIGEST => die() + unlink.
    await writeFile(join(dir, 'f'), 'hello mismatch\n');
    await expect(
      exec(BUILDER, ['snapshot', dir, WRONG_DIGEST, join(dir, 'out.img')]),
    ).rejects.toThrow();
    await expect(stat(join(dir, 'out.img'))).rejects.toThrow();
  });

  itIfBuilt('single-file mode rejects a symlinked source (O_NOFOLLOW)', async () => {
    await writeFile(join(dir, 'real-ca'), 'ca bytes');
    await symlink('real-ca', join(dir, 'ca-link'));
    await expect(
      exec(BUILDER, ['single-file', join(dir, 'ca-link'), 'ca.pem', WRONG_DIGEST, join(dir, 'out.img')]),
    ).rejects.toThrow();
    await expect(stat(join(dir, 'out.img'))).rejects.toThrow();
  });

  itIfBuilt('snapshot with empty subdir tree is traversed without crash (still mismatch => fail closed)', async () => {
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'data.bin'), Buffer.from([1, 2, 3]));
    await writeFile(join(dir, 'top.txt'), 'top');
    await expect(
      exec(BUILDER, ['snapshot', dir, WRONG_DIGEST, join(dir, 'out.img')]),
    ).rejects.toThrow();
    await expect(stat(join(dir, 'out.img'))).rejects.toThrow();
  });
});
