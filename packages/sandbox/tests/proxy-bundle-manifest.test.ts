import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyProxyBundle } from '../src/os/os-backend.js';
import { RootfsError } from '../src/os/rootfs.js';

/**
 * Plan 7 Task 1 — proxy-bundle manifest shape contract.
 *
 * `verifyProxyBundle()` is the REAL production verifier (exported from
 * os-backend.ts). The bundle script MUST emit a manifest this verifier
 * accepts. The canonical shape is:
 *   { schemaVersion: 1, helperSha256: <bare 64 hex>, size: <int>, mode: <int> }
 * The verifier REJECTS:
 *   - a `sha256:` prefix on the digest (must be bare hex)
 *   - the wrong field name (`sha256` instead of `helperSha256`)
 *   - a digest mismatch
 *   - a group/world-writable bundle file
 */

const BUNDLE_BYTES = Buffer.from(
  "// reproducible proxy bundle fixture\nconst x = 1;\nexport default x;\n",
  'utf8',
);

function hexOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeBundle(dir: string, mode = 0o644): Promise<{ bundlePath: string }> {
  const bundlePath = path.join(dir, 'egress-proxy-server.mjs');
  await writeFile(bundlePath, BUNDLE_BYTES, { mode: 0o600 });
  await chmod(bundlePath, mode);
  return { bundlePath };
}

async function writeManifest(dir: string, manifest: unknown): Promise<{ manifestPath: string }> {
  const manifestPath = path.join(dir, 'egress-proxy-server.mjs.manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest) + '\n', { mode: 0o644 });
  return { manifestPath };
}

describe('verifyProxyBundle manifest shape', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'oct-proxy-manifest-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('accepts the canonical shape { schemaVersion:1, helperSha256:<64hex>, size, mode }', async () => {
    const { bundlePath } = await writeBundle(dir);
    const { manifestPath } = await writeManifest(dir, {
      schemaVersion: 1,
      helperSha256: hexOf(BUNDLE_BYTES),
      mode: 0o644,
      size: BUNDLE_BYTES.length,
    });
    await expect(verifyProxyBundle(bundlePath, manifestPath)).resolves.toBeUndefined();
  });

  it('rejects a sha256: prefix on the digest', async () => {
    const { bundlePath } = await writeBundle(dir);
    const { manifestPath } = await writeManifest(dir, {
      schemaVersion: 1,
      helperSha256: 'sha256:' + hexOf(BUNDLE_BYTES),
      mode: 0o644,
      size: BUNDLE_BYTES.length,
    });
    await expect(verifyProxyBundle(bundlePath, manifestPath)).rejects.toBeInstanceOf(RootfsError);
  });

  it('rejects the wrong field name (sha256 instead of helperSha256)', async () => {
    const { bundlePath } = await writeBundle(dir);
    const { manifestPath } = await writeManifest(dir, {
      schemaVersion: 1,
      sha256: hexOf(BUNDLE_BYTES),
      mode: 0o644,
      size: BUNDLE_BYTES.length,
    });
    await expect(verifyProxyBundle(bundlePath, manifestPath)).rejects.toBeInstanceOf(RootfsError);
  });

  it('rejects a digest mismatch', async () => {
    const { bundlePath } = await writeBundle(dir);
    const wrongDigest = 'a'.repeat(64);
    const { manifestPath } = await writeManifest(dir, {
      schemaVersion: 1,
      helperSha256: wrongDigest,
      mode: 0o644,
      size: BUNDLE_BYTES.length,
    });
    await expect(verifyProxyBundle(bundlePath, manifestPath)).rejects.toBeInstanceOf(RootfsError);
  });

  it('rejects a group-writable bundle', async () => {
    const { bundlePath } = await writeBundle(dir, 0o664);
    const { manifestPath } = await writeManifest(dir, {
      schemaVersion: 1,
      helperSha256: hexOf(BUNDLE_BYTES),
      mode: 0o664,
      size: BUNDLE_BYTES.length,
    });
    await expect(verifyProxyBundle(bundlePath, manifestPath)).rejects.toBeInstanceOf(RootfsError);
  });

  it('rejects a world-writable bundle', async () => {
    const { bundlePath } = await writeBundle(dir, 0o646);
    const { manifestPath } = await writeManifest(dir, {
      schemaVersion: 1,
      helperSha256: hexOf(BUNDLE_BYTES),
      mode: 0o646,
      size: BUNDLE_BYTES.length,
    });
    await expect(verifyProxyBundle(bundlePath, manifestPath)).rejects.toBeInstanceOf(RootfsError);
  });
});
