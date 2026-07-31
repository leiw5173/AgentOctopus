// packages/sandbox-vm-native/tests/tcb-manifest.test.ts
// L1 test for the unified vm-tcb-manifest.json producer + consumer contract.
//
// The VM TCB (Trusted Computing Base) consists of four artifacts:
// helper (sandbox-vm-helper), libkrun, libkrunfw, imageBuilder (vm-image-builder).
// verifyVmTcb (@agentoctopus/sandbox) requires ALL FOUR in the manifest's
// artifacts map, each {sha256, size, mode}. The producer (build-vm-helper.mjs)
// writes a combined vm-tcb-manifest.json; the gate (run-vm-gates.mjs) reads it.
//
// This test exercises the manifest round-trip using TEMP fixture files (dummy
// binaries with known sha256) so it does not depend on the real TCB build. It
// asserts:
//   1. buildTcbManifest produces a manifest with all 4 artifacts each
//      {sha256,size,mode} and verifyVmTcb accepts it.
//   2. readArtifactRefsFromTcbManifest extracts the 4 sha256 refs from the
//      combined manifest (the gate's consumer path).
//   3. Fail-closed: if imageBuilder's per-artifact manifest is absent,
//      buildTcbManifest THROWS (never writes a 3-artifact manifest).
//   4. Fail-closed: if the combined manifest is missing an entry,
//      readArtifactRefsFromTcbManifest THROWS.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, chmod, rm, stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  buildTcbManifest,
  readArtifactRefsFromTcbManifest,
  readPerArtifactEntry,
  TCB_MANIFEST_NAME,
  IMAGE_BUILDER_MANIFEST_NAME,
} from '../scripts/tcb-manifest.mjs';

// verifyVmTcb (sandbox/src/vm/vm-helper-build.ts) resolves artifact names
// per-platform: libkrun.dylib / libkrunfw.dylib on darwin, libkrun.so /
// libkrunfw.so on Linux. The fixtures must name the files the platform-under-
// test looks up — hardcoding .dylib breaks the Linux lane.
const LIBKRUN = process.platform === 'darwin' ? 'libkrun.dylib' : 'libkrun.so';
const LIBKRUNFW = process.platform === 'darwin' ? 'libkrunfw.dylib' : 'libkrunfw.so';

// Resolve the sandbox dist path relative to this test file.
// tests/tcb-manifest.test.ts -> ../../sandbox/dist/vm/vm-helper-build.js
const __dirname = dirname(fileURLToPath(import.meta.url));
const SANDBOX_VMH_BUILD = resolve(__dirname, '..', '..', 'sandbox', 'dist', 'vm', 'vm-helper-build.js');

async function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(p);
    s.on('data', (c: Buffer) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

async function makeFile(dir: string, name: string, content: string, mode = 0o755) {
  const p = join(dir, name);
  await writeFile(p, content);
  await chmod(p, mode);
  return p;
}

async function makePerArtifactManifest(dir: string, name: string, sha: string, size: number, mode: number) {
  const manifestPath = join(dir, name);
  const manifest = {
    schemaVersion: 1,
    artifact: { sha256: sha, size, mode },
    source: { kind: 'test-fixture' },
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return manifestPath;
}

describe('unified vm-tcb-manifest (HI-3)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vm-tcb-mnf-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('buildTcbManifest writes vm-tcb-manifest.json with all 4 artifacts each {sha256,size,mode}', async () => {
    // Create dummy TCB binaries with known content.
    const helperContent = 'HELPER';
    const libkrunContent = 'LIBKRUN';
    const libkrunfwContent = 'KRUNFW';
    const imageBuilderContent = 'BUILDER';

    await makeFile(dir, 'sandbox-vm-helper', helperContent, 0o755);
    await makeFile(dir, LIBKRUN, libkrunContent, 0o644);
    await makeFile(dir, LIBKRUNFW, libkrunfwContent, 0o644);
    await makeFile(dir, 'vm-image-builder', imageBuilderContent, 0o755);

    // Write the imageBuilder per-artifact manifest (produced by its build step).
    const libkrunSha = await sha256File(join(dir, LIBKRUN));
    const libkrunfwSha = await sha256File(join(dir, LIBKRUNFW));
    const imageBuilderSha = await sha256File(join(dir, 'vm-image-builder'));
    const libkrunSt = await stat(join(dir, LIBKRUN));
    const libkrunfwSt = await stat(join(dir, LIBKRUNFW));
    const imageBuilderSt = await stat(join(dir, 'vm-image-builder'));

    await makePerArtifactManifest(dir, IMAGE_BUILDER_MANIFEST_NAME, imageBuilderSha, imageBuilderSt.size, imageBuilderSt.mode & 0o777);

    // The producer computes helper/libkrun/libkrunfw entries directly (from the
    // freshly-built/vendored dylibs) and reads only the imageBuilder entry from
    // its per-artifact manifest.
    const helperSha = await sha256File(join(dir, 'sandbox-vm-helper'));
    const helperSt = await stat(join(dir, 'sandbox-vm-helper'));

    const manifestPath = await buildTcbManifest({
      artifactsDir: dir,
      helper: { sha256: helperSha, size: helperSt.size, mode: helperSt.mode & 0o777 },
      libkrun: { sha256: libkrunSha, size: libkrunSt.size, mode: libkrunSt.mode & 0o777 },
      libkrunfw: { sha256: libkrunfwSha, size: libkrunfwSt.size, mode: libkrunfwSt.mode & 0o777 },
    });

    expect(manifestPath).toBe(join(dir, TCB_MANIFEST_NAME));
    expect(existsSync(manifestPath)).toBe(true);

    const raw = JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8'));
    expect(raw.schemaVersion).toBe(1);
    expect(Object.keys(raw.artifacts).sort()).toEqual(['helper', 'imageBuilder', 'libkrun', 'libkrunfw']);
    for (const [, entry] of Object.entries(raw.artifacts)) {
      const e = entry as { sha256: string; size: number; mode: number };
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof e.size).toBe('number');
      expect(e.size).toBeGreaterThan(0);
      expect(typeof e.mode).toBe('number');
    }
    expect(raw.artifacts.imageBuilder.sha256).toBe(imageBuilderSha);
  });

  it('verifyVmTcb accepts the combined manifest produced by buildTcbManifest', async () => {
    // verifyVmTcb lives in @agentoctopus/sandbox dist. Import it dynamically
    // so this test skipIfs cleanly when the sandbox dist is not built.
    let verifyVmTcb: ((input: { artifactsDir: string; manifestPath: string }) => Promise<unknown>) | null = null;
    try {
      const mod = await import(SANDBOX_VMH_BUILD);
      verifyVmTcb = mod.verifyVmTcb;
    } catch {
      verifyVmTcb = null;
    }
    if (typeof verifyVmTcb !== 'function') {
      console.warn('tcb-manifest test: verifyVmTcb not importable — sandbox dist not built. Skipping verifyVmTcb assertion.');
      return;
    }

    await makeFile(dir, 'sandbox-vm-helper', 'HELPER', 0o755);
    await makeFile(dir, LIBKRUN, 'LIBKRUN', 0o644);
    await makeFile(dir, LIBKRUNFW, 'KRUNFW', 0o644);
    await makeFile(dir, 'vm-image-builder', 'BUILDER', 0o755);

    const helperSha = await sha256File(join(dir, 'sandbox-vm-helper'));
    const helperSt = await stat(join(dir, 'sandbox-vm-helper'));
    const libkrunSha = await sha256File(join(dir, LIBKRUN));
    const libkrunfwSha = await sha256File(join(dir, LIBKRUNFW));
    const imageBuilderSha = await sha256File(join(dir, 'vm-image-builder'));
    const libkrunSt = await stat(join(dir, LIBKRUN));
    const libkrunfwSt = await stat(join(dir, LIBKRUNFW));
    const imageBuilderSt = await stat(join(dir, 'vm-image-builder'));

    await makePerArtifactManifest(dir, IMAGE_BUILDER_MANIFEST_NAME, imageBuilderSha, imageBuilderSt.size, imageBuilderSt.mode & 0o777);

    const manifestPath = await buildTcbManifest({
      artifactsDir: dir,
      helper: { sha256: helperSha, size: helperSt.size, mode: helperSt.mode & 0o777 },
      libkrun: { sha256: libkrunSha, size: libkrunSt.size, mode: libkrunSt.mode & 0o777 },
      libkrunfw: { sha256: libkrunfwSha, size: libkrunfwSt.size, mode: libkrunfwSt.mode & 0o777 },
    });

    const result = await verifyVmTcb!({ artifactsDir: dir, manifestPath });
    expect(result).toBeTruthy();
    expect((result as Record<string, string>).imageBuilder).toContain('vm-image-builder');
  });

  it('FAIL-CLOSED: buildTcbManifest throws when imageBuilder per-artifact manifest is absent', async () => {
    await makeFile(dir, 'sandbox-vm-helper', 'HELPER', 0o755);
    await makeFile(dir, LIBKRUN, 'LIBKRUN', 0o644);
    await makeFile(dir, LIBKRUNFW, 'KRUNFW', 0o644);
    // vm-image-builder binary + manifest intentionally ABSENT.

    const libkrunSha = await sha256File(join(dir, LIBKRUN));
    const libkrunfwSha = await sha256File(join(dir, LIBKRUNFW));
    const libkrunSt = await stat(join(dir, LIBKRUN));
    const libkrunfwSt = await stat(join(dir, LIBKRUNFW));
    const helperSha = await sha256File(join(dir, 'sandbox-vm-helper'));
    const helperSt = await stat(join(dir, 'sandbox-vm-helper'));

    await expect(
      buildTcbManifest({
        artifactsDir: dir,
        helper: { sha256: helperSha, size: helperSt.size, mode: helperSt.mode & 0o777 },
        libkrun: { sha256: libkrunSha, size: libkrunSt.size, mode: libkrunSt.mode & 0o777 },
        libkrunfw: { sha256: libkrunfwSha, size: libkrunfwSt.size, mode: libkrunfwSt.mode & 0o777 },
      }),
    ).rejects.toThrow(/imageBuilder/i);

    // Fail-closed: NO combined manifest was written.
    expect(existsSync(join(dir, TCB_MANIFEST_NAME))).toBe(false);
  });

  it('readArtifactRefsFromTcbManifest extracts 4 sha256 refs from the combined manifest', async () => {
    await makeFile(dir, 'sandbox-vm-helper', 'HELPER', 0o755);
    await makeFile(dir, LIBKRUN, 'LIBKRUN', 0o644);
    await makeFile(dir, LIBKRUNFW, 'KRUNFW', 0o644);
    await makeFile(dir, 'vm-image-builder', 'BUILDER', 0o755);

    const helperSha = await sha256File(join(dir, 'sandbox-vm-helper'));
    const helperSt = await stat(join(dir, 'sandbox-vm-helper'));
    const libkrunSha = await sha256File(join(dir, LIBKRUN));
    const libkrunfwSha = await sha256File(join(dir, LIBKRUNFW));
    const imageBuilderSha = await sha256File(join(dir, 'vm-image-builder'));
    const libkrunSt = await stat(join(dir, LIBKRUN));
    const libkrunfwSt = await stat(join(dir, LIBKRUNFW));
    const imageBuilderSt = await stat(join(dir, 'vm-image-builder'));

    await makePerArtifactManifest(dir, IMAGE_BUILDER_MANIFEST_NAME, imageBuilderSha, imageBuilderSt.size, imageBuilderSt.mode & 0o777);

    const manifestPath = await buildTcbManifest({
      artifactsDir: dir,
      helper: { sha256: helperSha, size: helperSt.size, mode: helperSt.mode & 0o777 },
      libkrun: { sha256: libkrunSha, size: libkrunSt.size, mode: libkrunSt.mode & 0o777 },
      libkrunfw: { sha256: libkrunfwSha, size: libkrunfwSt.size, mode: libkrunfwSt.mode & 0o777 },
    });

    const refs = await readArtifactRefsFromTcbManifest(manifestPath);
    expect(Object.keys(refs).sort()).toEqual(['helper', 'imageBuilder', 'libkrun', 'libkrunfw']);
    expect(refs.libkrun).toBe('sha256:' + libkrunSha);
    expect(refs.libkrunfw).toBe('sha256:' + libkrunfwSha);
    expect(refs.helper).toBe('sha256:' + helperSha);
    expect(refs.imageBuilder).toBe('sha256:' + imageBuilderSha);
  });

  it('FAIL-CLOSED: readArtifactRefsFromTcbManifest throws when combined manifest is missing', async () => {
    await expect(
      readArtifactRefsFromTcbManifest(join(dir, TCB_MANIFEST_NAME)),
    ).rejects.toThrow();
  });

  it('FAIL-CLOSED: readArtifactRefsFromTcbManifest throws when an artifact entry is malformed', async () => {
    // Write a combined manifest missing the imageBuilder entry.
    const malformed = {
      schemaVersion: 1,
      artifacts: {
        helper: { sha256: 'a'.repeat(64), size: 1, mode: 0o755 },
        libkrun: { sha256: 'b'.repeat(64), size: 1, mode: 0o644 },
        libkrunfw: { sha256: 'c'.repeat(64), size: 1, mode: 0o644 },
        // imageBuilder missing
      },
    };
    const manifestPath = join(dir, TCB_MANIFEST_NAME);
    await writeFile(manifestPath, JSON.stringify(malformed));

    await expect(
      readArtifactRefsFromTcbManifest(manifestPath),
    ).rejects.toThrow();
  });

  it('readPerArtifactEntry reads {sha256,size,mode} from a per-artifact manifest', async () => {
    const sha = 'a'.repeat(64);
    await makePerArtifactManifest(dir, 'test.manifest.json', sha, 42, 0o755);
    const entry = await readPerArtifactEntry(join(dir, 'test.manifest.json'));
    expect(entry.sha256).toBe(sha);
    expect(entry.size).toBe(42);
    expect(entry.mode).toBe(0o755);
  });

  it('readPerArtifactEntry returns null when the per-artifact manifest is absent', async () => {
    const entry = await readPerArtifactEntry(join(dir, 'nonexistent.manifest.json'));
    expect(entry).toBeNull();
  });
});
