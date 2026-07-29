// packages/sandbox/src/vm/gate-manifest.ts
import { createHash, verify } from 'node:crypto';
import { z } from 'zod';
import { RELEASE_PUBLIC_KEY_BASE64 } from './release-key.js';

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

/**
 * Verify the outer release manifest's Ed25519 signature against the compiled-in
 * public key. Uses Node's crypto.verify with null algorithm (Ed25519). Returns
 * false if the key is unset (placeholder) or verification fails. Exercised with
 * a real keypair in Task 16.
 */
export function verifyOuterReleaseManifest(outerBytes: Buffer, signature: Buffer): boolean {
  if (!RELEASE_PUBLIC_KEY_BASE64) return false;
  try {
    return verify(
      null,
      outerBytes,
      { key: Buffer.from(RELEASE_PUBLIC_KEY_BASE64, 'base64'), format: 'der', type: 'spki' },
      signature,
    );
  } catch {
    return false;
  }
}
