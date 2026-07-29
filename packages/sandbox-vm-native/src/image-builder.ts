// packages/sandbox-vm-native/src/image-builder.ts
// TS shim invoking the C `vm-image-builder` binary for sealed read-only ext4
// block-image construction. Two DISTINCT identities per artifact (R4 P1-2):
//   - ref           = block-image byte digest (sha256 over the .img bytes),
//                     printed by the C binary on stdout. This is the sealed
//                     artifact identity — what proves the image itself is intact.
//   - manifestDigest = snapshot tree identity for snapshot mode
//                     (== expectedSnapshotDigest, the canonical manifest digest
//                      the C builder recomputed and asserted during build), or
//                      the file digest for single-file mode (== expectedFileDigest).
// They are intentionally different: tampering with the ext4 bytes breaks ref;
// tampering with the source tree (caught at build time) breaks manifestDigest.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import type { VmImageBuilderPort, VerifiedArtifact } from '@agentoctopus/sandbox';

const execFileAsync = promisify(execFile);

const SHA256_REF_RE = /^sha256:[0-9a-f]{64}$/;

function parseByteDigest(stdout: string): string {
  // The C binary prints exactly one line: "sha256:<64hex>\n".
  const line = stdout.trim().split(/\r?\n/).pop() ?? '';
  if (!SHA256_REF_RE.test(line)) {
    throw new Error(`vm-image-builder: invalid byte digest on stdout: ${JSON.stringify(stdout)}`);
  }
  return line;
}

export class VmImageBuilderImpl implements VmImageBuilderPort {
  /**
   * @param builderBinaryPath absolute path to the compiled `vm-image-builder`.
   * Empty string => reject every call (the engine must resolve a real path
   * before constructing the backend; this guard keeps a misconfigured package
   * fail-closed rather than silently shelling out to an empty argv[0]).
   */
  constructor(private builderBinaryPath: string = '') {}

  private assertBinary(): string {
    if (!this.builderBinaryPath) {
      throw new Error('vm-image-builder: builder binary path not configured');
    }
    return this.builderBinaryPath;
  }

  async buildSnapshotImage(input: {
    sourceDir: string; expectedSnapshotDigest: string; outDir: string;
  }): Promise<VerifiedArtifact> {
    const bin = this.assertBinary();
    const outPath = path.join(input.outDir, 'skill.img');
    // The C builder recomputes the canonical snapshot digest during copy and
    // asserts it == expectedSnapshotDigest; on mismatch it deletes the output
    // and exits non-zero (fail closed).
    const { stdout } = await execFileAsync(
      bin,
      ['snapshot', input.sourceDir, input.expectedSnapshotDigest, outPath],
    );
    const ref = parseByteDigest(stdout);
    const st = await stat(outPath);
    return {
      ref,
      absolutePath: outPath,
      manifestDigest: input.expectedSnapshotDigest,
      size: st.size,
      mode: st.mode & 0o777,
    };
  }

  async buildSingleFileImage(input: {
    sourcePath: string; guestName: string; expectedFileDigest: string; outDir: string;
  }): Promise<VerifiedArtifact> {
    const bin = this.assertBinary();
    const outPath = path.join(input.outDir, 'ca.img');
    // The C builder re-reads the source via the SAME fd, recomputes its sha256,
    // and asserts == expectedFileDigest; on mismatch it deletes the output and
    // exits non-zero (fail closed).
    const { stdout } = await execFileAsync(
      bin,
      ['single-file', input.sourcePath, input.guestName, input.expectedFileDigest, outPath],
    );
    const ref = parseByteDigest(stdout);
    const st = await stat(outPath);
    return {
      ref,
      absolutePath: outPath,
      manifestDigest: input.expectedFileDigest,
      size: st.size,
      mode: st.mode & 0o777,
    };
  }
}
