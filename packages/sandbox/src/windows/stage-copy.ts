/**
 * Per-session staged copy for the Windows backend (spec §3, Decision 3).
 *
 * AppContainer shares the host Win32 filesystem namespace — there is no
 * Docker-style bind-map — so the verified snapshot + CA are delivered by
 * copying them into a per-session directory, re-verifying the copy against
 * `expectedSnapshotDigest`, and granting the skill's LPAC SIDs READ-only DACL
 * on the copy (the grant happens in WinSandboxBackend.prepare). On cleanup the
 * whole session directory is deleted wholesale, so the shared snapshot store's
 * DACL is never edited and no ACE can leak onto it.
 *
 * The digest re-verify is the TOCTOU guard: it defends against a mutation
 * between the runner's verifySnapshot (which runs immediately before
 * backend.prepare) and this copy. A mismatch throws — the copy is never used.
 *
 * This module is leaf-package production code: Node stdlib only.
 */
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { verifySnapshot } from '../snapshot.js';
import { WindowsSandboxError } from './errors.js';

export interface StageCopyArgs {
  /** Verified snapshot skill root (the content-addressed store path). */
  snapshotRoot: string;
  /** Per-session CA bundle produced at proxy launch. */
  caBundlePath: string;
  /** The runner-built `identity.digest` (sha256:<64 lowercase hex>). */
  expectedDigest: string;
  /** Per-session directory the copy is staged into. */
  sessionDir: string;
}

export interface StagedCopy {
  /** Staged copy of the snapshot skill root (the Windows guestSkillRoot). */
  guestSkillRoot: string;
  /** Staged copy of the CA bundle (the Windows guestCaBundlePath). */
  guestCaBundlePath: string;
}

/**
 * Copy the snapshot skill root + CA bundle into `sessionDir` and re-verify the
 * copied skill tree byte-for-byte against `expectedDigest`. Returns the staged
 * paths. Throws WindowsSandboxError on a digest mismatch or any I/O failure —
 * fail-closed, the staged copy is never used unverified.
 */
export async function stageVerifiedCopy(args: StageCopyArgs): Promise<StagedCopy> {
  if (typeof args.snapshotRoot !== 'string' || args.snapshotRoot.length === 0) {
    throw new WindowsSandboxError('snapshotRoot must be a non-empty string');
  }
  if (typeof args.caBundlePath !== 'string' || args.caBundlePath.length === 0) {
    throw new WindowsSandboxError('caBundlePath must be a non-empty string');
  }
  if (typeof args.sessionDir !== 'string' || args.sessionDir.length === 0) {
    throw new WindowsSandboxError('sessionDir must be a non-empty string');
  }

  const guestSkillRoot = path.join(args.sessionDir, 'skill');
  const guestCaBundlePath = path.join(args.sessionDir, 'ca.pem');

  await mkdir(args.sessionDir, { recursive: true });
  try {
    await cp(args.snapshotRoot, guestSkillRoot, { recursive: true });
    await cp(args.caBundlePath, guestCaBundlePath);
  } catch (err) {
    throw new WindowsSandboxError(`stage-copy failed: ${(err as Error).message}`);
  }

  // Byte-for-byte re-verify of the COPIED tree (not the source): recomputes
  // the canonical digest over guestSkillRoot and compares to the runner's
  // expected digest. A mismatch means the copy diverged from the verified
  // snapshot — throw, never mount it.
  const ok = await verifySnapshot(guestSkillRoot, args.expectedDigest);
  if (!ok) {
    throw new WindowsSandboxError(
      'stage-copy digest mismatch: staged copy does not match expectedSnapshotDigest (TOCTOU guard)',
    );
  }

  return { guestSkillRoot, guestCaBundlePath };
}
