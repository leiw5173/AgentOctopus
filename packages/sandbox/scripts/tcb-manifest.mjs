/**
 * tcb-manifest.mjs — shared per-artifact manifest helpers for the
 * packages/sandbox producer scripts (build-win-helper.mjs today; any future
 * trusted-artifact producer in this package).
 *
 * Per-artifact manifest shape (mirrors packages/sandbox-vm-native's
 * tcb-manifest.mjs and vendor-libkrun.mjs writeArtifactManifest):
 *
 *   { schemaVersion: 1, artifact: { sha256, size, mode }, source: {...} }
 *
 * - writePerArtifactManifest(): validates the entry and writes the manifest
 *   atomically (tmp + rename). FAIL-CLOSED: an invalid entry throws before
 *   anything touches disk.
 *
 * - readPerArtifactEntry(): reads a per-artifact manifest and returns the
 *   { sha256, size, mode } entry. Returns null when the file is absent;
 *   throws when the file exists but is malformed.
 *
 * This module is imported by the producer script and by tests. It contains
 * no top-level side effects — importing it never touches the filesystem.
 */
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * @typedef {object} PerArtifactEntry
 * @property {string} sha256 - 64 lowercase hex chars
 * @property {number} size   - positive integer byte count
 * @property {number} mode   - non-negative integer (POSIX mode bits; 0 on Windows)
 */

function assertEntry(entry, where) {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`${where}: entry is required`);
  }
  if (typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256)) {
    throw new Error(`${where}: entry.sha256 is not 64 lowercase hex (got ${JSON.stringify(entry.sha256)})`);
  }
  if (typeof entry.size !== 'number' || !Number.isInteger(entry.size) || entry.size <= 0) {
    throw new Error(`${where}: entry.size is not a positive integer (got ${JSON.stringify(entry.size)})`);
  }
  if (typeof entry.mode !== 'number' || !Number.isInteger(entry.mode) || entry.mode < 0) {
    throw new Error(`${where}: entry.mode is not a non-negative integer (got ${JSON.stringify(entry.mode)})`);
  }
}

/**
 * Write a per-artifact manifest atomically.
 *
 * @param {string} manifestPath - destination <name>.manifest.json
 * @param {PerArtifactEntry} entry
 * @param {object} source - provenance block, e.g. { kind: 'win-helper-c', file: 'src/windows/helper.c' }
 * @returns {Promise<string>} the manifestPath written
 */
export async function writePerArtifactManifest(manifestPath, entry, source) {
  assertEntry(entry, `writePerArtifactManifest(${manifestPath})`);
  const manifest = {
    schemaVersion: 1,
    artifact: { sha256: entry.sha256, size: entry.size, mode: entry.mode },
    source: source ?? {},
  };
  const tmp = path.join(
    path.dirname(manifestPath),
    `.tmp-${path.basename(manifestPath)}.${process.pid}-${Date.now()}`,
  );
  try {
    await fs.writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n');
    await fs.rename(tmp, manifestPath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return manifestPath;
}

/**
 * Read a per-artifact manifest and return its { sha256, size, mode } entry.
 * Returns null when the file does not exist. Throws when the file exists but
 * is not valid JSON or the artifact entry is malformed.
 *
 * @param {string} manifestPath
 * @returns {Promise<PerArtifactEntry|null>}
 */
export async function readPerArtifactEntry(manifestPath) {
  if (!existsSync(manifestPath)) return null;
  const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const art = raw?.artifact ?? raw;
  const entry = { sha256: art?.sha256, size: art?.size, mode: art?.mode };
  assertEntry(entry, `readPerArtifactEntry(${manifestPath})`);
  return entry;
}
