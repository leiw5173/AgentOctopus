// packages/sandbox-vm-native/tests/rootfs-ext4-stat.test.ts
// Test for createExt4StatRootfsFile — the DARWIN statRootfsFile seam that
// shells out to `vm-image-builder stat` to parse the sealed ext4 rootfs
// directly (no loopback mount, which macOS lacks). Exercises the real compiled
// C tool against a synthetic ext4 image plus the fail-closed output mapping.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExt4StatRootfsFile } from '../src/rootfs-ext4-stat.js';
import { RootfsMountError } from '../src/rootfs-loopback-mount.js';

const hasCc = spawnSync('cc', ['--version'], { encoding: 'utf8' }).status === 0;
const C_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'vm-image-builder.c');

// Minimal synthetic ext4 image (4K blocks, extents, linear dirs) with a single
// regular executable /usr/bin/node. Mirrors the fixture in
// vm-image-builder-stat.test.ts (kept self-contained here).
const BLK = 4096;
const le16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); return b; };
const le32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const EXT_MAGIC = 0xf30a, EXT_FL = 0x00080000, S_IFREG = 0o100000, S_IFDIR = 0o040000;
function buildImg(): Buffer {
  const INODE_SIZE = 128, N_INODES = 64, IT = 5, DATA_FIRST = IT + Math.ceil((N_INODES * INODE_SIZE) / BLK);
  const rootBlk = DATA_FIRST, usrBlk = DATA_FIRST + 1, binBlk = DATA_FIRST + 2, nodeBlk = DATA_FIRST + 3;
  const total = DATA_FIRST + 4;
  const img = Buffer.alloc(total * BLK);
  const put = (o: number, b: Buffer) => b.copy(img, o);
  const SB = 1024;
  put(SB + 0, le32(N_INODES)); put(SB + 4, le32(total)); put(SB + 0x14, le32(1)); put(SB + 0x18, le32(2));
  put(SB + 0x20, le32(8 * BLK)); put(SB + 0x28, le32(N_INODES)); put(SB + 0x38, le16(0xef53));
  put(SB + 0x58, le16(INODE_SIZE)); put(SB + 0x60, le32(0x0002 | 0x0040));
  put(1 * BLK + 0x08, le32(IT)); // GDT bg_inode_table_lo
  const ino = (n: number, mode: number, size: number, blk0: number) => {
    const o = IT * BLK + (n - 1) * INODE_SIZE;
    put(o, le16(mode)); put(o + 4, le32(size)); put(o + 0x20, le32(EXT_FL));
    const ib = o + 0x28;
    put(ib, le16(EXT_MAGIC)); put(ib + 2, le16(1)); put(ib + 4, le16(4)); put(ib + 6, le16(0)); put(ib + 8, le32(0));
    put(ib + 12, le32(0)); put(ib + 16, le16(1)); put(ib + 18, le16(0)); put(ib + 20, le32(blk0));
  };
  const dirblk = (blk: number, self: number, parent: number, kids: { ino: number; name: string; ft: number }[]) => {
    const base = blk * BLK; let off = 0;
    const de = (i: number, nm: string, ft: number, rl: number) => {
      put(base + off, le32(i)); put(base + off + 4, le16(rl)); img[base + off + 6] = nm.length; img[base + off + 7] = ft; put(base + off + 8, Buffer.from(nm)); off += rl;
    };
    de(self, '.', 2, 12);
    if (!kids.length) { de(parent, '..', 2, BLK - off); return; }
    de(parent, '..', 2, 12);
    kids.forEach((c, i) => de(c.ino, c.name, c.ft, i === kids.length - 1 ? BLK - off : (8 + c.name.length + 3) & ~3));
  };
  dirblk(rootBlk, 2, 2, [{ ino: 12, name: 'usr', ft: 2 }]);
  dirblk(usrBlk, 12, 2, [{ ino: 13, name: 'bin', ft: 2 }]);
  dirblk(binBlk, 13, 12, [{ ino: 14, name: 'node', ft: 1 }]);
  put(nodeBlk * BLK, Buffer.from('\x7fELF'));
  ino(2, S_IFDIR | 0o755, BLK, rootBlk);
  ino(12, S_IFDIR | 0o755, BLK, usrBlk);
  ino(13, S_IFDIR | 0o755, BLK, binBlk);
  ino(14, S_IFREG | 0o755, 4, nodeBlk);
  return img;
}

describe('createExt4StatRootfsFile (darwin ext4 stat seam)', () => {
  let dir = '';
  let builder = '';
  let imgPath = '';
  beforeAll(async () => {
    if (!hasCc) return;
    dir = await mkdtemp(path.join(tmpdir(), 'vm-ext4-stat-'));
    builder = path.join(dir, 'vm-image-builder');
    const cc = spawnSync('cc', ['-O2', '-std=gnu17', '-Wall', '-Werror', '-o', builder, C_SRC], { encoding: 'utf8' });
    if (cc.status !== 0) throw new Error(`compile failed:\n${cc.stderr}`);
    imgPath = path.join(dir, 'rootfs.img');
    await writeFile(imgPath, buildImg());
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('maps a regular executable verdict to ExecStatResult', { skip: !hasCc }, async () => {
    const stat = createExt4StatRootfsFile(builder);
    await expect(stat(imgPath, '/usr/bin/node')).resolves.toEqual({ isReg: true, isExec: true, isSymlink: false });
  });

  it('returns null on ENOENT (tool prints null)', { skip: !hasCc }, async () => {
    const stat = createExt4StatRootfsFile(builder);
    await expect(stat(imgPath, '/usr/bin/missing')).resolves.toBeNull();
  });

  it('throws RootfsMountError when the tool exits non-zero (fail-closed)', { skip: !hasCc }, async () => {
    const stat = createExt4StatRootfsFile(builder);
    const garbage = path.join(dir, 'garbage.img');
    await writeFile(garbage, Buffer.alloc(2048, 0xbb));
    await expect(stat(garbage, '/usr/bin/node')).rejects.toBeInstanceOf(RootfsMountError);
  });

  it('supports a lazy resolver for the builder path', { skip: !hasCc }, async () => {
    const stat = createExt4StatRootfsFile(async () => builder);
    await expect(stat(imgPath, '/usr/bin/node')).resolves.toEqual({ isReg: true, isExec: true, isSymlink: false });
  });

  it('throws when the builder path resolves empty (fail-closed)', { skip: !hasCc }, async () => {
    const stat = createExt4StatRootfsFile(async () => '');
    await expect(stat(imgPath, '/usr/bin/node')).rejects.toBeInstanceOf(RootfsMountError);
  });

  it('throws when the builder binary does not exist (spawn error, fail-closed)', { skip: !hasCc }, async () => {
    const stat = createExt4StatRootfsFile(path.join(dir, 'no-such-binary'));
    await expect(stat(imgPath, '/usr/bin/node')).rejects.toBeInstanceOf(RootfsMountError);
  });
});
