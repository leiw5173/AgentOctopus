// packages/sandbox/tests/windows/runtime-manifest.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyWindowsRuntimeManifest, WindowsRuntimeManifestError } from '../../src/windows/runtime-manifest.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('verifyWindowsRuntimeManifest', () => {
  it('verifies a well-formed manifest', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'winrt-'));
    const node = path.join(dir, 'node.exe'); writeFileSync(node, 'node-bytes');
    const boot = path.join(dir, 'bootstrap.cjs'); writeFileSync(boot, 'boot-bytes');
    const manifest = {
      schemaVersion: 1, nodePath: node, bootstrapPath: boot, undiciDir: dir,
      nodeSha256: sha('node-bytes'), bootstrapSha256: sha('boot-bytes'),
      entries: [
        { path: node, sha256: sha('node-bytes'), size: 10 },
        { path: boot, sha256: sha('boot-bytes'), size: 10 },
      ],
    };
    const mp = path.join(dir, 'runtime.manifest.json'); writeFileSync(mp, JSON.stringify(manifest));
    const m = await verifyWindowsRuntimeManifest(mp);
    expect(m.nodePath).toBe(node);
  });
  it('rejects a digest mismatch', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'winrt-'));
    const node = path.join(dir, 'node.exe'); writeFileSync(node, 'node-bytes');
    const boot = path.join(dir, 'bootstrap.cjs'); writeFileSync(boot, 'boot-bytes');
    const manifest = {
      schemaVersion: 1, nodePath: node, bootstrapPath: boot, undiciDir: dir,
      nodeSha256: sha('WRONG'), bootstrapSha256: sha('boot-bytes'),
      entries: [ { path: node, sha256: sha('WRONG'), size: 10 } ],
    };
    const mp = path.join(dir, 'runtime.manifest.json'); writeFileSync(mp, JSON.stringify(manifest));
    await expect(verifyWindowsRuntimeManifest(mp)).rejects.toBeInstanceOf(WindowsRuntimeManifestError);
  });
});
