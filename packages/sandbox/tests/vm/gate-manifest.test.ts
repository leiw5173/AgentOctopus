import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { computeManifestDigest, verifyGateManifest } from '../../src/vm/gate-manifest.js';

function bodyWithout(d: any) { const { manifestDigest, ...rest } = d; return rest; }

describe('gate manifest', () => {
  const baseManifest = {
    platform: 'darwin-arm64',
    schemaVersion: 1,
    artifacts: {
      libkrun: 'sha256:' + 'a'.repeat(64),
      libkrunfw: 'sha256:' + 'b'.repeat(64),
      helper: 'sha256:' + 'c'.repeat(64),
      imageBuilder: 'sha256:' + 'd'.repeat(64),
    },
    qualifiedRootfsDigests: ['sha256:' + 'e'.repeat(64)],
    libkrunAbi: 'v1.19.4',
    blkFeatureRequired: true,
    gates: { G1: 'GO', G2: 'GO' },
    gateReasons: [],
    qualifiedAt: '2026-07-29T00:00:00Z',
  };

  it('manifestDigest = sha256 over canonical body EXCLUDING manifestDigest field', () => {
    const body = bodyWithout(baseManifest);
    const expected = 'sha256:' + createHash('sha256').update(JSON.stringify(body)).digest('hex');
    expect(computeManifestDigest(baseManifest)).toBe(expected);
  });

  it('manifest with tampered body fails manifestDigest verification', () => {
    const tampered = { ...baseManifest, gates: { G1: 'NO-GO', G2: 'GO' } };
    const digest = computeManifestDigest(baseManifest); // original digest
    const manifest = { ...tampered, manifestDigest: digest };
    const r = verifyGateManifest(manifest, baseManifest.artifacts);
    expect(r.ok).toBe(false);
  });

  it('manifest missing qualifiedRootfsDigests => rejected', () => {
    const bad = { ...baseManifest, qualifiedRootfsDigests: [] };
    const manifest = { ...bad, manifestDigest: computeManifestDigest(bad) };
    const r = verifyGateManifest(manifest, baseManifest.artifacts);
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.includes('qualifiedRootfsDigests'))).toBe(true);
  });

  it('probe does NOT check selected rootfs (parameterless); assertRootfsQualified checks membership separately', () => {
    // verifyGateManifest checks the list is present+non-empty, NOT membership of a specific rootfs.
    const manifest = { ...baseManifest, manifestDigest: computeManifestDigest(baseManifest) };
    const r = verifyGateManifest(manifest, baseManifest.artifacts);
    expect(r.ok).toBe(true); // passes even though no specific rootfs was checked
  });
});
