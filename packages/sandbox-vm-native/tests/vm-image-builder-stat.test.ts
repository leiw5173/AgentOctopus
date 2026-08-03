// packages/sandbox-vm-native/tests/vm-image-builder-stat.test.ts
// L1 test for the vm-image-builder `stat` mode: a self-contained ext4 READER
// used by the darwin VM lane's assertExecutablesQualified (macOS cannot
// loopback-mount ext4). It parses the mke2fs-produced rootfs (4K blocks,
// extents, linear dirs) directly via the pinned fd — no mount, no external
// binary.
//
// mke2fs is NOT available on the dev box, so the fixture is a byte-exact
// MINIMAL ext4 image built in JS (buildTestImage below): 4K blocks, superblock
// at 1024, one block group, GDT at block 1, an inode table, and extent-based
// files/dirs. This controls every field and exercises the real parse path
// without any external tool.
//
// The C tool is compiled IN the test (guarded on a C toolchain) so it runs on
// a clean checkout — the same hasCc pattern as private-tcb-loader.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hasCc = spawnSync('cc', ['--version'], { encoding: 'utf8' }).status === 0;
const C_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'vm-image-builder.c',
);

// ---- synthetic minimal ext4 image (4K blocks, extents, linear dirs) --------
// Little-endian writers.
const BLK = 4096;
function le16(v: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); return b; }
function le32(v: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; }

const EXT4_EXT_MAGIC = 0xf30a;
const EXT4_EXTENTS_FL = 0x00080000;
const S_IFREG = 0o100000, S_IFDIR = 0o040000, S_IFLNK = 0o120000;

export interface TestFile {
  guestPath: string; // absolute, e.g. /usr/bin/node (must be one level deep or two)
  mode: number;      // full i_mode incl. format bits
  data?: Buffer;     // file content (single block); dirs are synthesized
}

// Build an image with root dir (inode 2) + a flat set of second-level entries.
// Build an image from arbitrary-depth guest paths. A directory TRIE is built
// from the file paths (intermediate components become directories); each node
// gets a fresh inode (root = 2, then 12+) and one data block. File data is
// `data` (single block); directory data is a synthesized dirent block. All
// inodes reference their data block via a depth-0 extent header in i_block.
function buildTestImage(files: TestFile[]): Buffer {
  const INODE_SIZE = 128;
  const N_INODES = 64;
  const BLOCKS_PER_GROUP = 8 * BLK; // s_blocks_per_group (bitmap coverage)
  const GDT_BLK = 1;
  const INODE_TABLE_BLK = 5;
  const DATA_FIRST = INODE_TABLE_BLK + Math.ceil((N_INODES * INODE_SIZE) / BLK); // 5+2=7

  // ---- build the directory trie ----
  interface Node {
    name: string;             // basename ('' for root)
    mode: number;             // full i_mode incl. format bits
    data: Buffer;             // file content (dirs: synthesized later)
    isDir: boolean;
    ino: number;
    dataBlk: number;
    parent: Node | null;
    children: Map<string, Node>;
  }
  const root: Node = { name: '', mode: S_IFDIR | 0o755, data: Buffer.alloc(0), isDir: true, ino: 2, dataBlk: 0, parent: null, children: new Map() };

  for (const f of files) {
    const comp = f.guestPath.replace(/^\/+/, '').split('/').filter(Boolean);
    let cur = root;
    for (let i = 0; i < comp.length; i++) {
      const isLeaf = i === comp.length - 1;
      let child = cur.children.get(comp[i]);
      if (!child) {
        child = {
          name: comp[i],
          mode: isLeaf ? f.mode : (S_IFDIR | 0o755),
          data: isLeaf ? (f.data ?? Buffer.alloc(0)) : Buffer.alloc(0),
          isDir: !isLeaf,
          ino: 0, dataBlk: 0, parent: cur, children: new Map(),
        };
        cur.children.set(comp[i], child);
      }
      cur = child;
    }
  }

  // ---- assign inodes + data blocks (BFS for determinism) ----
  let nextIno = 12;
  let nextBlk = DATA_FIRST;
  root.dataBlk = nextBlk++;
  const all: Node[] = [root];
  const queue: Node[] = [root];
  while (queue.length) {
    const n = queue.shift()!;
    for (const c of n.children.values()) {
      c.ino = nextIno++;
      c.dataBlk = nextBlk++;
      all.push(c);
      queue.push(c);
    }
  }

  const totalBlocks = nextBlk; // one past last used
  const img = Buffer.alloc(totalBlocks * BLK);
  const put = (off: number, buf: Buffer) => buf.copy(img, off);

  // ---- superblock @ 1024 ----
  const SB = 1024;
  put(SB + 0x00, le32(N_INODES));            // s_inodes_count
  put(SB + 0x04, le32(totalBlocks));         // s_blocks_count_lo
  put(SB + 0x14, le32(1));                   // s_first_data_block
  put(SB + 0x18, le32(2));                   // s_log_block_size (2 => 4096)
  put(SB + 0x20, le32(BLOCKS_PER_GROUP));    // s_blocks_per_group
  put(SB + 0x28, le32(N_INODES));            // s_inodes_per_group
  put(SB + 0x38, le16(0xef53));              // s_magic
  put(SB + 0x58, le16(INODE_SIZE));          // s_inode_size
  put(SB + 0x60, le32(0x0002 | 0x0040));     // s_feature_incompat = filetype|extents

  // ---- GDT @ block 1 ----
  const GDT = GDT_BLK * BLK;
  put(GDT + 0x08, le32(INODE_TABLE_BLK));    // bg_inode_table_lo

  // ---- inode writer (depth-0 extent in i_block) ----
  function writeInode(ino: number, mode: number, sizeLo: number, flags: number, blk0: number): void {
    const off = INODE_TABLE_BLK * BLK + (ino - 1) * INODE_SIZE;
    put(off + 0x00, le16(mode));             // i_mode
    put(off + 0x04, le32(sizeLo));           // i_size_lo
    put(off + 0x20, le32(flags));            // i_flags
    const ib = off + 0x28;
    put(ib + 0, le16(EXT4_EXT_MAGIC));       // eh_magic
    put(ib + 2, le16(1));                    // eh_entries
    put(ib + 4, le16(4));                    // eh_max
    put(ib + 6, le16(0));                    // eh_depth (0 = leaf)
    put(ib + 8, le32(0));                    // eh_generation
    put(ib + 12 + 0, le32(0));               // ee_block (logical 0)
    put(ib + 12 + 4, le16(1));               // ee_len (1 block)
    put(ib + 12 + 6, le16(0));               // ee_start_hi
    put(ib + 12 + 8, le32(blk0));            // ee_start_lo
  }

  // ---- dirent block writer (last entry stretches to block end) ----
  function writeDirBlock(blk: number, selfIno: number, parentIno: number, children: { ino: number; name: string; ftype: number }[]): void {
    const base = blk * BLK;
    let off = 0;
    const dirent = (ino: number, name: string, ftype: number, recLen: number) => {
      put(base + off + 0, le32(ino));
      put(base + off + 4, le16(recLen));
      img[base + off + 6] = name.length & 0xff;
      img[base + off + 7] = ftype & 0xff;
      put(base + off + 8, Buffer.from(name, 'utf8'));
      off += recLen;
    };
    dirent(selfIno, '.', 2, 12);
    if (children.length === 0) {
      dirent(parentIno, '..', 2, BLK - off);   // '..' stretches to end
      return;
    }
    dirent(parentIno, '..', 2, 12);
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      const need = (8 + c.name.length + 3) & ~3;
      const recLen = i === children.length - 1 ? BLK - off : need;
      dirent(c.ino, c.name, c.ftype, recLen);
    }
  }

  // ---- emit every node ----
  for (const n of all) {
    if (n.isDir) {
      const kids = [...n.children.values()].map((c) => ({ ino: c.ino, name: c.name, ftype: ftypeOf(c.mode) }));
      writeDirBlock(n.dataBlk, n.ino, n.parent ? n.parent.ino : n.ino, kids);
      writeInode(n.ino, n.mode, BLK, EXT4_EXTENTS_FL, n.dataBlk);
    } else {
      if (n.data.length > 0) put(n.dataBlk * BLK, n.data);
      writeInode(n.ino, n.mode, n.data.length, EXT4_EXTENTS_FL, n.dataBlk);
    }
  }

  return img;
}

function ftypeOf(mode: number): number {
  const fmt = mode & 0o170000;
  if (fmt === S_IFDIR) return 2;
  if (fmt === S_IFLNK) return 7;
  return 1;
}

describe('vm-image-builder stat mode (C ext4 reader)', () => {
  let dir = '';
  let builder = '';
  beforeAll(async () => {
    if (!hasCc) return;
    dir = await mkdtemp(path.join(tmpdir(), 'vm-ib-stat-'));
    builder = path.join(dir, 'vm-image-builder');
    const cc = spawnSync('cc', ['-O2', '-std=gnu17', '-Wall', '-Werror', '-o', builder, C_SRC], { encoding: 'utf8' });
    if (cc.status !== 0) throw new Error(`compile failed:\n${cc.stderr}`);
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const run = (args: string[]) => spawnSync(builder, args, { encoding: 'utf8' });

  // Write a fixture image to a uniquely-named file and return its path.
  let imgCounter = 0;
  const writeImg = async (files: TestFile[]): Promise<string> => {
    const p = path.join(dir, `fs-${imgCounter++}.img`);
    await writeFile(p, buildTestImage(files));
    return p;
  };
  const statPath = (imgPath: string, guestPath: string) => run(['stat', imgPath, guestPath]);

  it('parses a valid superblock (magic check passes)', { skip: !hasCc }, async () => {
    const imgPath = await writeImg([]);
    // A valid image must NOT die on the superblock magic check; an absent
    // path resolves to ENOENT → prints null, exit 0.
    const r = statPath(imgPath, '/nonexistent');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('null');
  });

  it('fails closed on a garbage/truncated image (bad superblock)', { skip: !hasCc }, async () => {
    const imgPath = path.join(dir, 'garbage.img');
    await writeFile(imgPath, Buffer.alloc(2048, 0xaa)); // no valid magic @ 0x438
    const r = statPath(imgPath, '/usr/bin/node');
    expect(r.status).not.toBe(0);
  });

  it('qualifies a regular executable file (two-level path /usr/bin/node)', { skip: !hasCc }, async () => {
    const imgPath = await writeImg([
      { guestPath: '/usr/bin/node', mode: S_IFREG | 0o755, data: Buffer.from('\x7fELF-node') },
    ]);
    const r = statPath(imgPath, '/usr/bin/node');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ isReg: 1, isExec: 1, isSymlink: 0 });
  });

  it('reports a regular NON-executable file as isExec=0 (qualification rejects)', { skip: !hasCc }, async () => {
    const imgPath = await writeImg([
      { guestPath: '/usr/bin/data', mode: S_IFREG | 0o644, data: Buffer.from('x') },
    ]);
    const r = statPath(imgPath, '/usr/bin/data');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ isReg: 1, isExec: 0, isSymlink: 0 });
  });

  it('detects a symlink from i_mode WITHOUT following it (isSymlink=1)', { skip: !hasCc }, async () => {
    const imgPath = await writeImg([
      { guestPath: '/usr/bin/node', mode: S_IFREG | 0o755, data: Buffer.from('real') },
      { guestPath: '/etc/linky', mode: S_IFLNK | 0o777, data: Buffer.from('/usr/bin/node') },
    ]);
    const r = statPath(imgPath, '/etc/linky');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ isReg: 0, isExec: 0, isSymlink: 1 });
  });

  it('returns null (ENOENT) for a missing leaf and a missing intermediate dir', { skip: !hasCc }, async () => {
    const imgPath = await writeImg([
      { guestPath: '/usr/bin/node', mode: S_IFREG | 0o755, data: Buffer.from('x') },
    ]);
    expect(statPath(imgPath, '/usr/bin/missing').stdout.trim()).toBe('null');
    expect(statPath(imgPath, '/no/such/dir').stdout.trim()).toBe('null');
  });

  it('reports a directory as present-but-not-a-regular-file (isReg=0)', { skip: !hasCc }, async () => {
    const imgPath = await writeImg([
      { guestPath: '/usr/bin/node', mode: S_IFREG | 0o755, data: Buffer.from('x') },
    ]);
    const r = statPath(imgPath, '/usr/bin');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ isReg: 0, isExec: 0, isSymlink: 0 });
  });

  it('fails closed when a directory is hash-indexed (EXT4_INDEX_FL set)', { skip: !hasCc }, async () => {
    // Build a normal image, then flip the root dir inode's i_flags to set
    // EXT4_INDEX_FL — the reader must die rather than attempt an htree walk.
    const img = buildTestImage([{ guestPath: '/usr/bin/node', mode: S_IFREG | 0o755, data: Buffer.from('x') }]);
    const INODE_TABLE_OFF = 5 * 4096;           // inode table block 5
    const rootInodeOff = INODE_TABLE_OFF + (2 - 1) * 128;
    img.writeUInt32LE(img.readUInt32LE(rootInodeOff + 0x20) | 0x00001000, rootInodeOff + 0x20);
    const imgPath = path.join(dir, 'htree.img');
    await writeFile(imgPath, img);
    expect(statPath(imgPath, '/usr/bin/node').status).not.toBe(0);
  });

  it('fails closed when an inode lacks the extents flag (indirect blocks unsupported)', { skip: !hasCc }, async () => {
    const img = buildTestImage([{ guestPath: '/usr/bin/node', mode: S_IFREG | 0o755, data: Buffer.from('x') }]);
    const INODE_TABLE_OFF = 5 * 4096;
    const rootInodeOff = INODE_TABLE_OFF + (2 - 1) * 128;
    img.writeUInt32LE(0, rootInodeOff + 0x20); // clear EXT4_EXTENTS_FL on root dir
    const imgPath = path.join(dir, 'indirect.img');
    await writeFile(imgPath, img);
    expect(statPath(imgPath, '/usr/bin/node').status).not.toBe(0);
  });

  it('fails closed on a corrupted extent magic', { skip: !hasCc }, async () => {
    const img = buildTestImage([{ guestPath: '/usr/bin/node', mode: S_IFREG | 0o755, data: Buffer.from('x') }]);
    const INODE_TABLE_OFF = 5 * 4096;
    const rootInodeOff = INODE_TABLE_OFF + (2 - 1) * 128;
    img.writeUInt16LE(0xdead, rootInodeOff + 0x28); // corrupt eh_magic in i_block
    const imgPath = path.join(dir, 'badmagic.img');
    await writeFile(imgPath, img);
    expect(statPath(imgPath, '/usr/bin/node').status).not.toBe(0);
  });
});
