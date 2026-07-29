// packages/sandbox/tests/vm/block-image.test.ts
import { describe, it, expect } from 'vitest';
import { buildBlockImages } from '../../src/vm/block-image.js';
import type { VmImageBuilderPort, VerifiedArtifact } from '../../src/vm/ports.js';

function fakeBuilder(calls: any[]): VmImageBuilderPort {
  return {
    async buildSnapshotImage(input) {
      calls.push({ method: 'buildSnapshotImage', ...input });
      return { ref: 'sha256:skill', absolutePath: '/tmp/skill.img', manifestDigest: 'sha256:skill', size: 100, mode: 0o444 } satisfies VerifiedArtifact;
    },
    async buildSingleFileImage(input) {
      calls.push({ method: 'buildSingleFileImage', ...input });
      return { ref: 'sha256:ca', absolutePath: '/tmp/ca.img', manifestDigest: 'sha256:ca', size: 50, mode: 0o444 } satisfies VerifiedArtifact;
    },
  };
}

describe('block-image orchestration', () => {
  it('delegates skill image to buildSnapshotImage (directory + snapshot digest)', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'vm-block-'));
    const caPath = join(dir, 'ca.pem');
    await writeFile(caPath, 'ca');
    const calls: any[] = [];
    const opts = { snapshotRoot: dir, expectedSnapshotDigest: 'sha256:' + 'a'.repeat(64), caBundlePath: caPath, outDir: dir };
    await buildBlockImages(fakeBuilder(calls), opts);
    const skillCall = calls.find((c) => c.method === 'buildSnapshotImage');
    expect(skillCall.sourceDir).toBe(dir);
    expect(skillCall.expectedSnapshotDigest).toBe(opts.expectedSnapshotDigest);
    expect(skillCall.outDir).toBe(dir);
  });

  it('delegates CA image to buildSingleFileImage (NOT buildSnapshotImage)', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'vm-block-'));
    const caPath = join(dir, 'ca.pem');
    await writeFile(caPath, 'ca');
    const calls: any[] = [];
    await buildBlockImages(fakeBuilder(calls), { snapshotRoot: dir, expectedSnapshotDigest: 'sha256:' + 'a'.repeat(64), caBundlePath: caPath, outDir: dir });
    const caCall = calls.find((c) => c.method === 'buildSingleFileImage');
    expect(caCall).toBeDefined();
    expect(caCall.guestName).toBe('ca.pem');
  });

  it('computes CA expectedFileDigest (sha256 of the file) BEFORE calling buildSingleFileImage', async () => {
    // uses a real temp file so the sha256 is deterministic
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'vm-block-'));
    const caPath = join(dir, 'ca.pem');
    await writeFile(caPath, 'hello-ca');
    const calls: any[] = [];
    await buildBlockImages(fakeBuilder(calls), { snapshotRoot: dir, expectedSnapshotDigest: 'sha256:' + 'a'.repeat(64), caBundlePath: caPath, outDir: dir });
    const caCall = calls.find((c) => c.method === 'buildSingleFileImage');
    const { createHash } = await import('node:crypto');
    const expected = 'sha256:' + createHash('sha256').update('hello-ca').digest('hex');
    expect(caCall.expectedFileDigest).toBe(expected);
  });

  it('on builder throwing, prepare fails closed (propagates)', async () => {
    const failingBuilder: VmImageBuilderPort = {
      async buildSnapshotImage() { throw new Error('digest mismatch'); },
      async buildSingleFileImage() { throw new Error('x'); },
    };
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'vm-block-'));
    const caPath = join(dir, 'ca.pem');
    await writeFile(caPath, 'ca');
    await expect(buildBlockImages(failingBuilder, { snapshotRoot: dir, expectedSnapshotDigest: 'sha256:' + 'a'.repeat(64), caBundlePath: caPath, outDir: dir })).rejects.toThrow('digest mismatch');
  });
});
