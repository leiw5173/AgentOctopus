/**
 * Plan 4, Task 3 — digest-verified trusted os-helper artifact pair.
 *
 * The helper binary (`runtime/os-helper`) and its manifest
 * (`runtime/os-helper.manifest.json`) are produced by Task 2.5's
 * `scripts/build-os-helper.mjs` on a Linux host with a static-capable C
 * toolchain. This module owns the canonical `HelperArtifactManifest` schema
 * and the fail-closed `verifyHelperArtifact()` check that
 * `buildOsRunCommand()` runs immediately before every launch.
 *
 * Producer/consumer contract (reconciles the Task 2.5 provisional schema):
 *   - `schemaVersion`: literal 1
 *   - `helperSha256`: 64 lowercase hex, SHA-256 over the helper bytes
 *   - `size`: exact byte length of the helper file
 *   - `mode`: expected file permission bits (0o755 for the shipped helper)
 *
 * Fail-closed rules enforced here:
 *   - Manifest parses and matches the strict schema (no extra keys).
 *   - Helper is a regular file, not a symlink.
 *   - Helper bytes SHA-256 match the manifest digest.
 *   - Helper byte length matches `size`.
 *   - Helper permission bits match `mode` exactly.
 *   - Helper is never group/world-writable, regardless of `mode`.
 *
 * Leaf-package rule: Node stdlib + zod only.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, stat } from 'node:fs/promises';
import { z } from 'zod';

export class HelperArtifactError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HelperArtifactError';
  }
}

// ---------------------------------------------------------------------------
// Schema (strict — no extra keys)
// ---------------------------------------------------------------------------

const SHA256_RE = /^[0-9a-f]{64}$/;

export const HelperArtifactManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    helperSha256: z.string().regex(SHA256_RE, 'helperSha256 must be 64 lowercase hex'),
    size: z.number().int().positive(),
    mode: z.number().int().nonnegative(),
  })
  .strict();

export type HelperArtifactManifest = z.infer<typeof HelperArtifactManifestSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(p);
    s.on('data', (c: Buffer) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface VerifyHelperArtifactOptions {
  helperPath: string;
  manifestPath: string;
}

/**
 * Verify that the helper binary at `helperPath` matches the digest, size,
 * and mode declared in `manifestPath`. Throws `HelperArtifactError` on ANY
 * discrepancy — there is no warning/degraded mode.
 *
 * `buildOsRunCommand()` calls this immediately before every launch; the
 * result is never cached across launches.
 */
export async function verifyHelperArtifact(
  opts: VerifyHelperArtifactOptions,
): Promise<HelperArtifactManifest> {
  // Phase 1: parse + strict-validate the manifest.
  const raw = await readFile(opts.manifestPath, 'utf8').catch((err) => {
    throw new HelperArtifactError(`cannot read helper manifest: ${(err as Error).message}`);
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new HelperArtifactError(`helper manifest is not valid JSON: ${(err as Error).message}`);
  }
  const res = HelperArtifactManifestSchema.safeParse(parsed);
  if (!res.success) {
    const msg = res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new HelperArtifactError(`helper manifest schema validation failed: ${msg}`);
  }
  const manifest = res.data;

  // Phase 2: lstat — the helper must be a regular file, not a symlink.
  const lst = await lstat(opts.helperPath).catch((err) => {
    throw new HelperArtifactError(`cannot lstat helper: ${(err as Error).message}`);
  });
  if (lst.isSymbolicLink()) {
    throw new HelperArtifactError(`helper at ${opts.helperPath} is a symlink — refusing to launch`);
  }
  if (!lst.isFile()) {
    throw new HelperArtifactError(`helper at ${opts.helperPath} is not a regular file`);
  }

  // Phase 3: digest + size from a single streaming pass.
  const digest = await sha256File(opts.helperPath).catch((err) => {
    throw new HelperArtifactError(`cannot read helper: ${(err as Error).message}`);
  });
  if (digest !== manifest.helperSha256) {
    throw new HelperArtifactError(
      `helper digest mismatch: manifest declares ${manifest.helperSha256}, computed ${digest}`,
    );
  }
  const st = await stat(opts.helperPath);
  if (st.size !== manifest.size) {
    throw new HelperArtifactError(
      `helper size mismatch: manifest declares ${manifest.size}, file is ${st.size}`,
    );
  }

  // Phase 4: mode must match exactly, and group/world-writable is forbidden
  // even if the manifest (somehow) declared it.
  const actualMode = st.mode & 0o7777;
  if (actualMode !== manifest.mode) {
    throw new HelperArtifactError(
      `helper mode mismatch: manifest declares ${manifest.mode.toString(8)}, file is ${actualMode.toString(8)}`,
    );
  }
  if ((actualMode & 0o022) !== 0) {
    throw new HelperArtifactError(
      `helper at ${opts.helperPath} is group/world-writable (mode ${actualMode.toString(8)}) — refusing to launch`,
    );
  }

  return manifest;
}
