// packages/sandbox/src/vm/block-image.ts
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { VmImageBuilderPort, VerifiedArtifact } from './ports.js';

async function sha256OfFile(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(p);
    s.on('data', (c: Buffer) => h.update(c));
    s.on('end', () => resolve('sha256:' + h.digest('hex')));
    s.on('error', reject);
  });
}

export async function buildBlockImages(
  builder: VmImageBuilderPort,
  opts: { snapshotRoot: string; expectedSnapshotDigest: string; caBundlePath: string; outDir: string },
): Promise<{ skillBlockImage: VerifiedArtifact; caBlockImage: VerifiedArtifact }> {
  // R4 P1-2: skill image (directory + snapshot digest)
  const skillBlockImage = await builder.buildSnapshotImage({
    sourceDir: opts.snapshotRoot,
    expectedSnapshotDigest: opts.expectedSnapshotDigest,
    outDir: opts.outDir,
  });
  // R4 P1-2: CA image (single file + file digest — backend computes expectedFileDigest FIRST)
  const expectedFileDigest = await sha256OfFile(opts.caBundlePath);
  const caBlockImage = await builder.buildSingleFileImage({
    sourcePath: opts.caBundlePath,
    guestName: 'ca.pem',
    expectedFileDigest,
    outDir: opts.outDir,
  });
  return { skillBlockImage, caBlockImage };
}
