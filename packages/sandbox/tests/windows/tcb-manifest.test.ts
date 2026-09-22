// packages/sandbox/tests/windows/tcb-manifest.test.ts
// Unit tests for the shared per-artifact manifest helpers in
// packages/sandbox/scripts/tcb-manifest.mjs (consumed by build-win-helper.mjs).
//
// Asserts real behavior, not tautologies:
//   - writePerArtifactManifest writes a schemaVersion-1 manifest whose
//     artifact entry round-trips through readPerArtifactEntry.
//   - writePerArtifactManifest REJECTS malformed entries before touching disk
//     (sha256 not 64-hex / uppercase, size non-positive or non-integer,
//     mode negative) and leaves no manifest file behind.
//   - readPerArtifactEntry returns null for an absent file, accepts the
//     bare-entry shape ({sha256,size,mode} at top level), and THROWS on
//     malformed JSON or malformed entries.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  writePerArtifactManifest,
  readPerArtifactEntry,
} from '../../scripts/tcb-manifest.mjs';

const VALID_SHA = createHash('sha256').update('hello').digest('hex');
const OTHER_SHA = createHash('sha256').update('world').digest('hex');

describe('sandbox scripts/tcb-manifest.mjs', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'win-tcb-mnf-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('writePerArtifactManifest writes schemaVersion-1 JSON that readPerArtifactEntry round-trips', async () => {
    const manifestPath = join(dir, 'octopus-sandbox-helper.exe.manifest.json');
    const written = await writePerArtifactManifest(
      manifestPath,
      { sha256: VALID_SHA, size: 12345, mode: 0 },
      { kind: 'win-helper-c', file: 'src/windows/helper/helper.c' },
    );
    expect(written).toBe(manifestPath);
    expect(existsSync(manifestPath)).toBe(true);

    const raw = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(raw.schemaVersion).toBe(1);
    expect(raw.artifact).toEqual({ sha256: VALID_SHA, size: 12345, mode: 0 });
    expect(raw.source).toEqual({ kind: 'win-helper-c', file: 'src/windows/helper/helper.c' });

    const entry = await readPerArtifactEntry(manifestPath);
    expect(entry).toEqual({ sha256: VALID_SHA, size: 12345, mode: 0 });
  });

  it('writePerArtifactManifest rejects a non-hex sha256 and writes nothing', async () => {
    const manifestPath = join(dir, 'bad-sha.manifest.json');
    await expect(
      writePerArtifactManifest(manifestPath, { sha256: 'not-hex', size: 1, mode: 0 }, {}),
    ).rejects.toThrow(/sha256 is not 64 lowercase hex/);
    expect(existsSync(manifestPath)).toBe(false);
  });

  it('writePerArtifactManifest rejects an uppercase sha256 (must be lowercase)', async () => {
    const manifestPath = join(dir, 'upper-sha.manifest.json');
    await expect(
      writePerArtifactManifest(manifestPath, { sha256: VALID_SHA.toUpperCase(), size: 1, mode: 0 }, {}),
    ).rejects.toThrow(/sha256 is not 64 lowercase hex/);
    expect(existsSync(manifestPath)).toBe(false);
  });

  it('writePerArtifactManifest rejects a non-positive size and writes nothing', async () => {
    const manifestPath = join(dir, 'zero-size.manifest.json');
    await expect(
      writePerArtifactManifest(manifestPath, { sha256: VALID_SHA, size: 0, mode: 0 }, {}),
    ).rejects.toThrow(/size is not a positive integer/);
    expect(existsSync(manifestPath)).toBe(false);
  });

  it('writePerArtifactManifest rejects a negative mode and writes nothing', async () => {
    const manifestPath = join(dir, 'neg-mode.manifest.json');
    await expect(
      writePerArtifactManifest(manifestPath, { sha256: VALID_SHA, size: 1, mode: -1 }, {}),
    ).rejects.toThrow(/mode is not a non-negative integer/);
    expect(existsSync(manifestPath)).toBe(false);
  });

  it('readPerArtifactEntry returns null when the file is absent', async () => {
    expect(await readPerArtifactEntry(join(dir, 'missing.manifest.json'))).toBeNull();
  });

  it('readPerArtifactEntry accepts the bare-entry shape (no artifact wrapper)', async () => {
    const manifestPath = join(dir, 'bare.manifest.json');
    await writeFile(manifestPath, JSON.stringify({ sha256: OTHER_SHA, size: 42, mode: 0 }));
    expect(await readPerArtifactEntry(manifestPath)).toEqual({ sha256: OTHER_SHA, size: 42, mode: 0 });
  });

  it('readPerArtifactEntry throws on malformed JSON', async () => {
    const manifestPath = join(dir, 'not-json.manifest.json');
    await writeFile(manifestPath, '{ this is not json');
    await expect(readPerArtifactEntry(manifestPath)).rejects.toThrow();
  });

  it('readPerArtifactEntry throws on a sha256/size mismatch-shaped entry', async () => {
    // A manifest whose digest field is 64-hex but the size is a string —
    // i.e. an entry that LOOKS plausible but fails strict validation.
    const manifestPath = join(dir, 'bad-size.manifest.json');
    await writeFile(
      manifestPath,
      JSON.stringify({ schemaVersion: 1, artifact: { sha256: VALID_SHA, size: '12345', mode: 0 }, source: {} }),
    );
    await expect(readPerArtifactEntry(manifestPath)).rejects.toThrow(/size is not a positive integer/);
  });
});
