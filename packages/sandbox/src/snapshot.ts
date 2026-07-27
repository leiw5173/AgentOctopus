import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { InstallationIdentity } from './types.js';

export class SnapshotError extends Error {}

export interface BuiltSnapshot {
  identity: InstallationIdentity;
  snapshotRoot: string;
}

interface ManifestEntry {
  path: string;         // normalized (NFC), forward-slash relative path
  type: 'file' | 'dir' | 'symlink';
  mode: number;         // canonical executable bits only; chmod read-only does not change identity
  linkTarget?: string;  // for symlinks (must stay inside root)
  sha256?: string;      // for files
}

function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Normalize a relative path: NFC + forward slashes + no leading './'. */
function normalizeRel(p: string): string {
  return p.split(path.sep).join('/').normalize('NFC');
}

async function walk(root: string, rel: string, entries: ManifestEntry[]): Promise<void> {
  const abs = path.join(root, rel);
  const st = await fsp.lstat(abs);

  // Reject hard links (more than one name → ambiguous identity).
  if (st.isFile() && st.nlink > 1) {
    throw new SnapshotError(`hard link not allowed in snapshot: ${rel}`);
  }
  // Reject device nodes, sockets, FIFOs.
  if (st.isFIFO() || st.isSocket() || st.isCharacterDevice() || st.isBlockDevice()) {
    throw new SnapshotError(`special file not allowed in snapshot: ${rel}`);
  }

  const nrel = normalizeRel(rel);

  if (st.isDirectory()) {
    // Directories record only path + executable mode bits; they carry no content
    // hash by design. Tampering inside a directory is detected via the leaf
    // entries themselves (every file/symlink under it is its own manifest entry
    // with a sha256/linkTarget). A directory whose child is removed or replaced
    // is therefore detected by the child entry changing/disappearing, not by a
    // recursive hash on the directory.
    entries.push({ path: nrel, type: 'dir', mode: st.mode & 0o111 });
    const children = (await fsp.readdir(abs)).sort();
    for (const c of children) {
      await walk(root, path.join(rel, c), entries);
    }
  } else if (st.isSymbolicLink()) {
    const target = await fsp.readlink(abs);
    const resolved = path.resolve(path.dirname(abs), target);
    const rootResolved = path.resolve(root);
    // Allow in-root symlinks (including one pointing at the root itself): the
    // target is inside the snapshot tree, so it cannot escape. A symlink to the
    // root widens read access within the snapshot but never beyond it.
    if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
      throw new SnapshotError(`symlink escapes snapshot root: ${rel} -> ${target}`);
    }
    entries.push({ path: nrel, type: 'symlink', mode: 0, linkTarget: normalizeRel(target) });
  } else if (st.isFile()) {
    const bytes = await fsp.readFile(abs);
    entries.push({ path: nrel, type: 'file', mode: st.mode & 0o111, sha256: sha256(bytes) });
  }
}

function canonicalDigest(entries: ManifestEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  // Detect case/Unicode collisions: two distinct paths that fold to the same key.
  const seen = new Map<string, string>();
  for (const e of sorted) {
    const key = e.path.toLowerCase();
    if (seen.has(key) && seen.get(key) !== e.path) {
      throw new SnapshotError(`path collision (case/unicode): ${seen.get(key)} vs ${e.path}`);
    }
    seen.set(key, e.path);
  }
  return 'sha256:' + sha256(JSON.stringify(sorted));
}

async function copyTree(srcDir: string, destDir: string): Promise<void> {
  await fsp.mkdir(destDir, { recursive: true });
  const children = await fsp.readdir(srcDir, { withFileTypes: true });
  for (const c of children) {
    const s = path.join(srcDir, c.name);
    const d = path.join(destDir, c.name);
    if (c.isDirectory()) {
      await copyTree(s, d);
    } else if (c.isSymbolicLink()) {
      const target = await fsp.readlink(s);
      await fsp.symlink(target, d);
    } else if (c.isFile()) {
      await fsp.copyFile(s, d);
      // preserve executable bit
      const st = await fsp.stat(s);
      await fsp.chmod(d, st.mode & 0o777);
    }
  }
}

/** Recursively drop write bits (defense-in-depth; verifySnapshot is authoritative). */
async function chmodTreeReadOnly(dir: string): Promise<void> {
  const children = await fsp.readdir(dir, { withFileTypes: true });
  for (const c of children) {
    const p = path.join(dir, c.name);
    if (c.isDirectory()) {
      await chmodTreeReadOnly(p);
      const st = await fsp.stat(p);
      await fsp.chmod(p, st.mode & 0o555);
    } else if (c.isFile()) {
      const st = await fsp.stat(p);
      await fsp.chmod(p, st.mode & 0o555);
    }
  }
}

/**
 * Build a content-addressed, immutable execution snapshot from a skill source
 * dir (spec §4). The returned snapshotRoot is what backends mount — never the
 * mutable source dir.
 */
export async function buildSnapshot(opts: {
  sourceDir: string;
  storeDir: string;
  installationId: string;
  name?: string;
  source?: InstallationIdentity['source'];
}): Promise<BuiltSnapshot> {
  const { sourceDir, storeDir, installationId, name, source } = opts;
  const entries: ManifestEntry[] = [];
  await walk(sourceDir, '', entries);
  const digest = canonicalDigest(entries.filter(e => e.path !== ''));
  const snapshotRoot = path.join(storeDir, digest);

  if (!fs.existsSync(snapshotRoot)) {
    const staging = snapshotRoot + '.tmp-' + process.pid;
    await copyTree(sourceDir, staging);
    // Make the snapshot immutable (best effort; ownership permitting). The
    // digest re-check in verifySnapshot() is the authoritative guard — this
    // chmod is defense-in-depth, not the enforcement mechanism.
    await chmodTreeReadOnly(staging).catch(() => {});
    await fsp.rename(staging, snapshotRoot);
  }

  return {
    identity: { installationId, digest, snapshotRef: digest, name: name ?? '', source },
    snapshotRoot,
  };
}

/** Recompute the digest of an existing snapshot and compare. */
export async function verifySnapshot(snapshotRoot: string, expectedDigest: string): Promise<boolean> {
  try {
    const entries: ManifestEntry[] = [];
    await walk(snapshotRoot, '', entries);
    const digest = canonicalDigest(entries.filter(e => e.path !== ''));
    return digest === expectedDigest;
  } catch {
    return false;
  }
}
