#!/usr/bin/env node
/** Vendor pinned undici into packages/sandbox/images/runtime/undici/ with a
 *  SHA-256 integrity check against images.lock.json (undiciTarball/undiciSha256). */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.resolve(HERE, '..', 'images', 'runtime');
const LOCK = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'images', 'images.lock.json'), 'utf8'));
const { undiciVersion, undiciTarball, undiciSha256 } = LOCK;
if (!undiciVersion || !undiciTarball || !undiciSha256) {
  console.error('images.lock.json missing undiciVersion/undiciTarball/undiciSha256');
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oct-undici-'));
try {
  const tgz = path.join(tmp, 'undici.tgz');
  execFileSync('curl', ['-fsSL', undiciTarball, '-o', tgz]);
  const got = createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
  if (got !== undiciSha256) {
    console.error(`undici tarball sha256 mismatch: got ${got}, want ${undiciSha256}`);
    process.exit(1);
  }
  execFileSync('tar', ['-xzf', tgz, '-C', tmp]);
  const dest = path.join(RUNTIME_DIR, 'undici');
  fs.rmSync(dest, { recursive: true, force: true });
  // Copy, not rename: os.tmpdir() may be on a different volume than the repo
  // (e.g. CI runner TEMP on C: vs checkout on D:), and fs.rename across
  // volumes throws EXDEV on Windows. cp + rm is volume-agnostic.
  fs.cpSync(path.join(tmp, 'package'), dest, { recursive: true });
  console.log(`vendored undici@${undiciVersion} -> ${dest}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
