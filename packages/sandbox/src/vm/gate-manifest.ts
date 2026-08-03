// packages/sandbox/src/vm/gate-manifest.ts
import { createHash, verify } from 'node:crypto';
import { z } from 'zod';
import { RELEASE_PUBLIC_KEY_BASE64, RELEASE_PUBLIC_KEY_TEST_SEAM } from './release-key.js';

const SHA256_REF_RE = /^sha256:[0-9a-f]{64}$/;

export const GateManifestSchema = z.object({
  platform: z.enum(['darwin-arm64', 'linux-x64']),
  schemaVersion: z.literal(1),
  artifacts: z.object({
    libkrun: z.string().regex(SHA256_REF_RE),
    libkrunfw: z.string().regex(SHA256_REF_RE),
    helper: z.string().regex(SHA256_REF_RE),
    imageBuilder: z.string().regex(SHA256_REF_RE),
  }).strict(),
  qualifiedRootfsDigests: z.array(z.string().regex(SHA256_REF_RE)),
  libkrunAbi: z.literal('v1.19.4'),
  blkFeatureRequired: z.literal(true),
  gates: z.object({ G1: z.enum(['GO', 'NO-GO']), G2: z.enum(['GO', 'NO-GO']) }).strict(),
  gateReasons: z.array(z.string()),
  qualifiedAt: z.string(),
  manifestDigest: z.string().regex(SHA256_REF_RE),
}).strict();

export type GateManifest = z.infer<typeof GateManifestSchema>;

export function computeManifestDigest(body: Omit<GateManifest, 'manifestDigest'> | GateManifest): string {
  const { manifestDigest, ...rest } = body as GateManifest;
  return 'sha256:' + createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

export function verifyGateManifest(
  manifest: GateManifest,
  loadedArtifactDigests: { libkrun: string; libkrunfw: string; helper: string; imageBuilder: string },
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (computeManifestDigest(manifest) !== manifest.manifestDigest) reasons.push('manifestDigest mismatch (body tampered)');
  if (manifest.gates.G1 !== 'GO') reasons.push('G1 NO-GO');
  if (manifest.gates.G2 !== 'GO') reasons.push('G2 NO-GO');
  if (manifest.qualifiedRootfsDigests.length === 0) reasons.push('qualifiedRootfsDigests empty');
  for (const k of ['libkrun', 'libkrunfw', 'helper', 'imageBuilder'] as const) {
    if (manifest.artifacts[k] !== loadedArtifactDigests[k]) reasons.push(`artifact ${k} digest mismatch`);
  }
  return { ok: reasons.length === 0, reasons };
}

// Rootfs membership check (called from prepare(), NOT probe()).
export function isRootfsQualified(manifest: GateManifest, rootfsRef: string): boolean {
  return manifest.qualifiedRootfsDigests.includes(rootfsRef);
}

export type ReleaseVerifyResult =
  | { ok: true; reason: 'ok' }
  | { ok: false; reason: 'no-key' | 'bad-signature' };

/**
 * Verify the outer release manifest's Ed25519 signature against the compiled-in
 * public key. Uses Node's crypto.verify with null algorithm (Ed25519).
 *
 * - 'no-key': the compiled-in public key is the placeholder '' (no real key
 *   committed yet) AND the test seam is also unset. The caller can treat this as
 *   an unverifiable release manifest.
 * - 'bad-signature': a real key is available but verification failed — the caller
 *   MUST fail closed.
 * - 'ok': signature verified.
 */
export function verifyOuterReleaseManifest(outerBytes: Buffer, signature: Buffer): ReleaseVerifyResult {
  const publicKeyBase64 = RELEASE_PUBLIC_KEY_BASE64 || RELEASE_PUBLIC_KEY_TEST_SEAM;
  if (!publicKeyBase64) {
    return { ok: false, reason: 'no-key' };
  }
  try {
    const ok = verify(
      null,
      outerBytes,
      { key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' },
      signature,
    );
    return ok ? { ok: true, reason: 'ok' } : { ok: false, reason: 'bad-signature' };
  } catch {
    return { ok: false, reason: 'bad-signature' };
  }
}
