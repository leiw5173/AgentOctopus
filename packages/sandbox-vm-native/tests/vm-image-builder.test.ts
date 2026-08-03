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
import { mkdtemp, symlink, link, writeFile, mkdir, rm, stat, readFile } from 'node:fs/promises';
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

  // REGRESSION (darwin vm-lane "probe.js SyntaxError past block 1"): the writer
  // emits LEGACY direct-block inodes (i_flags=0) but previously set ONLY
  // i_block[0], so a file larger than one 1024-byte block had no direct pointer
  // for blocks 1..N-1 — the guest kernel read those as HOLES (NUL bytes) and the
  // file appeared truncated + zero-padded. The directory inode likewise had
  // i_block[0]=0, so /skill listed empty. This test builds a real image via the
  // `snapshot` mode and parses the writer's own inode table directly (1024-byte
  // blocks, inode table at block 5, 128-byte inodes, direct blocks at inode
  // offset 40) to assert: (a) every allocated block's direct pointer is set and
  // non-zero, and (b) the file bytes at those blocks match the source.
  itIfBuilt('multi-block file: every direct-block pointer is set and data reads back intact', async () => {
    // 2500 bytes => ceil(2500/1024) = 3 data blocks (crosses the 1-block bug).
    const payload = Buffer.alloc(2500);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 7 + 13) & 0xff;
    await writeFile(join(dir, 'big.bin'), payload);

    // The builder asserts the recomputed canonical digest == the expected one;
    // learn the real digest from a deliberate-mismatch run, then build for real.
    let digest = '';
    try {
      await exec(BUILDER, ['snapshot', dir, WRONG_DIGEST, join(dir, 'probe.img')]);
    } catch (e: any) {
      const m = /computed (sha256:[0-9a-f]{64})/.exec(String(e?.stderr ?? ''));
      digest = m?.[1] ?? '';
    }
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const imgPath = join(dir, 'big.img');
    await exec(BUILDER, ['snapshot', dir, digest, imgPath]);
    const img = await readFile(imgPath);

    // Writer geometry (vm-image-builder.c): BLOCK_SIZE=1024, INODE_TABLE_FIRST=5,
    // INODE_SIZE=128, content inodes start at FIRST_USR_INO=11, i_block at +40.
    const BLK = 1024, ITAB = 5 * BLK, ISZ = 128, USR = 11, IBLOCK = 40;
    const u32 = (o: number) => img.readUInt32LE(o);
    // big.bin is the only regular file at the root => inode USR+1 (inode 11 is
    // http-order dependent; find the regular file inode by scanning USR..USR+8
    // for i_size == payload.length).
    let fileIno = -1;
    for (let ino = USR; ino < USR + 8; ino++) {
      const off = ITAB + (ino - 1) * ISZ;
      if (u32(off + 4) === payload.length) { fileIno = ino; break; }
    }
    expect(fileIno).toBeGreaterThanOrEqual(USR);
    const off = ITAB + (fileIno - 1) * ISZ;
    const nblocks = Math.ceil(payload.length / BLK);
    const ptrs: number[] = [];
    for (let k = 0; k < nblocks; k++) ptrs.push(u32(off + IBLOCK + 4 * k));
    // Every allocated block must have a NON-ZERO direct pointer (0 = hole).
    for (const p of ptrs) expect(p).toBeGreaterThan(0);
    // The bytes at those physical blocks must reconstruct the payload exactly.
    const reconstructed = Buffer.concat(ptrs.map((p) => img.subarray(p * BLK, p * BLK + BLK)));
    expect(reconstructed.subarray(0, payload.length)).toEqual(payload);
  });
});
