/**
 * tcb-manifest.mjs — unified vm-tcb-manifest.json producer + consumer helpers.
 *
 * The VM TCB (Trusted Computing Base) consists of four artifacts:
 *   helper       (sandbox-vm-helper, built by build-vm-helper.mjs)
 *   libkrun      (libkrun.{dylib,so}, vendored by vendor-libkrun.mjs)
 *   libkrunfw    (libkrunfw.{dylib,so}, vendored by vendor-libkrun.mjs)
 *   imageBuilder (vm-image-builder, built by build-vm-helper.mjs)
 *
 * verifyVmTcb (@agentoctopus/sandbox vm-helper-build.ts) requires ALL FOUR in
 * the manifest's artifacts map, each {sha256, size, mode}. This module:
 *
 *   - buildTcbManifest(): aggregates the 4 per-artifact entries into ONE
 *     combined vm-tcb-manifest.json. Reads libkrun/libkrunfw/imageBuilder from
 *     their own per-artifact manifests; helper's stats are passed in directly
 *     (the producer just built it). FAIL-CLOSED if any per-artifact manifest
 *     is absent or malformed — never writes a partial 3-artifact manifest.
 *
 *   - readArtifactRefsFromTcbManifest(): reads the combined manifest and
 *     extracts the 4 artifacts.<name>.sha256 values as `sha256:<hex>` refs.
 *     Used by run-vm-gates.mjs. FAIL-CLOSED if the combined manifest is
 *     missing or any entry is malformed.
 *
 *   - readPerArtifactEntry(): reads a single per-artifact manifest
 *     ({schemaVersion, artifact:{sha256,size,mode}, source}) and returns
 *     the {sha256,size,mode} entry. Returns null if the file is absent.
 *
 * This module is imported by both the producer (build-vm-helper.mjs), the
 * gate (run-vm-gates.mjs), and its unit test. It deliberately contains no
 * top-level side effects so importing it for tests never touches the filesystem.
 */
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const SHA256_RE = /^[0-9a-f]{64}$/;
const SHA256_REF_RE = /^sha256:[0-9a-f]{64}$/;

/** Filename of the combined TCB manifest, written into the artifacts dir. */
export const TCB_MANIFEST_NAME = 'vm-tcb-manifest.json';

/** Filename of the imageBuilder per-artifact manifest. */
export const IMAGE_BUILDER_MANIFEST_NAME = 'vm-image-builder.manifest.json';

/**
 * Read a per-artifact manifest (libkrun.manifest.json, vm-image-builder.manifest.json,
 * etc.) and return the {sha256, size, mode} entry. Returns null if the file
 * does not exist.
 *
 * Per-artifact manifest shape (written by vendor-libkrun.mjs writeArtifactManifest
 * and by build-vm-helper.mjs for the imageBuilder):
 *   { schemaVersion: 1, artifact: { sha256, size, mode }, source: {...} }
 *
 * @throws if the file exists but is not valid JSON, or the artifact entry is
 *         missing/malformed (sha256 not 64-hex, size not positive int, mode
 *         not non-negative int).
 */
export async function readPerArtifactEntry(manifestPath) {
  if (!existsSync(manifestPath)) return null;
  const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const art = raw?.artifact ?? raw;
  const sha = art?.sha256;
  const size = art?.size;
  const mode = art?.mode;
  if (typeof sha !== 'string' || !SHA256_RE.test(sha)) {
    throw new Error(`per-artifact manifest ${manifestPath}: artifact.sha256 missing or not 64 lowercase hex (got ${JSON.stringify(sha)})`);
  }
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
    throw new Error(`per-artifact manifest ${manifestPath}: artifact.size missing or not a positive integer (got ${JSON.stringify(size)})`);
  }
  if (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0) {
    throw new Error(`per-artifact manifest ${manifestPath}: artifact.mode missing or not a non-negative integer (got ${JSON.stringify(mode)})`);
  }
  return { sha256: sha, size, mode };
}

/**
 * Build + write the combined vm-tcb-manifest.json. Aggregates the helper,
 * libkrun, and libkrunfw entries (passed in directly — the producer just built
 * or vendored them) with the imageBuilder entry read from its per-artifact
 * manifest in artifactsDir.
 *
 * FAIL-CLOSED: if the imageBuilder per-artifact manifest is absent or
 * malformed, THROWS and does NOT write a combined manifest. verifyVmTcb
 * requires all 4; writing a 3-artifact manifest that verifyVmTcb would reject
 * is worse than failing loudly at build time.
 *
 * @param {object} input
 * @param {string} input.artifactsDir     - directory holding the TCB artifacts + per-artifact manifests
 * @param {{sha256:string,size:number,mode:number}} input.helper     - helper entry (just computed)
 * @param {{sha256:string,size:number,mode:number}} input.libkrun    - libkrun entry (just computed from dylib)
 * @param {{sha256:string,size:number,mode:number}} input.libkrunfw  - libkrunfw entry (just computed from dylib)
 * @returns {Promise<string>} the path to the written vm-tcb-manifest.json
 */
export async function buildTcbManifest({ artifactsDir, helper, libkrun, libkrunfw }) {
  if (!helper || typeof helper !== 'object') {
    throw new Error('buildTcbManifest: helper entry is required');
  }
  for (const [name, entry] of [['helper', helper], ['libkrun', libkrun], ['libkrunfw', libkrunfw]]) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`buildTcbManifest: ${name} entry is required`);
    }
    if (!SHA256_RE.test(entry.sha256 ?? '')) {
      throw new Error(`buildTcbManifest: ${name}.sha256 is not 64 lowercase hex (got ${JSON.stringify(entry.sha256)})`);
    }
    if (typeof entry.size !== 'number' || entry.size <= 0) {
      throw new Error(`buildTcbManifest: ${name}.size is not a positive integer (got ${JSON.stringify(entry.size)})`);
    }
    if (typeof entry.mode !== 'number' || entry.mode < 0) {
      throw new Error(`buildTcbManifest: ${name}.mode is not a non-negative integer (got ${JSON.stringify(entry.mode)})`);
    }
  }

  // Read the imageBuilder per-artifact manifest. This is the one entry that is
  // produced by a separate build step (vm-image-builder) and must be present.
  const imageBuilderEntry = await readPerArtifactEntry(path.join(artifactsDir, IMAGE_BUILDER_MANIFEST_NAME));
  if (!imageBuilderEntry) {
    throw new Error(
      `buildTcbManifest: ${IMAGE_BUILDER_MANIFEST_NAME} not found in ${artifactsDir}\n` +
      '  The imageBuilder (vm-image-builder) artifact + its per-artifact manifest are required\n' +
      '  for a complete TCB. verifyVmTcb rejects a manifest missing imageBuilder.\n' +
      '  Run security:build-vm to produce all four TCB artifacts.',
    );
  }

  const manifest = {
    schemaVersion: 1,
    artifacts: {
      helper: { sha256: helper.sha256, size: helper.size, mode: helper.mode },
      libkrun: { sha256: libkrun.sha256, size: libkrun.size, mode: libkrun.mode },
      libkrunfw: { sha256: libkrunfw.sha256, size: libkrunfw.size, mode: libkrunfw.mode },
      imageBuilder: { sha256: imageBuilderEntry.sha256, size: imageBuilderEntry.size, mode: imageBuilderEntry.mode },
    },
  };

  const manifestPath = path.join(artifactsDir, TCB_MANIFEST_NAME);
  const tmp = path.join(artifactsDir, `.tmp-${TCB_MANIFEST_NAME}.${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n');
    await fs.rename(tmp, manifestPath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return manifestPath;
}

/**
 * Read the combined vm-tcb-manifest.json and extract the 4 artifact sha256
 * refs as `sha256:<hex>` strings (the gate manifest stores refs, not bare hex).
 *
 * FAIL-CLOSED: if the combined manifest is missing, not valid JSON, or any of
 * the 4 artifact entries is absent/malformed, THROWS.
 *
 * @param {string} manifestPath - path to vm-tcb-manifest.json
 * @returns {Promise<{helper:string, libkrun:string, libkrunfw:string, imageBuilder:string}>}
 */
export async function readArtifactRefsFromTcbManifest(manifestPath) {
  if (!existsSync(manifestPath)) {
    throw new Error(
      `readArtifactRefsFromTcbManifest: combined manifest not found at ${manifestPath}\n` +
      '  Run security:build-vm to produce vm-tcb-manifest.json.',
    );
  }
  const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (raw?.schemaVersion !== 1) {
    throw new Error(`readArtifactRefsFromTcbManifest: schemaVersion is not 1 (got ${JSON.stringify(raw?.schemaVersion)})`);
  }
  const artifacts = raw?.artifacts;
  if (!artifacts || typeof artifacts !== 'object') {
    throw new Error('readArtifactRefsFromTcbManifest: artifacts map missing or not an object');
  }
  const refs = {};
  for (const name of ['helper', 'libkrun', 'libkrunfw', 'imageBuilder']) {
    const entry = artifacts[name];
    if (!entry || typeof entry !== 'object') {
      throw new Error(`readArtifactRefsFromTcbManifest: artifact '${name}' entry missing`);
    }
    const sha = entry.sha256;
    if (typeof sha !== 'string' || !SHA256_RE.test(sha)) {
      throw new Error(`readArtifactRefsFromTcbManifest: artifact '${name}'.sha256 is not 64 lowercase hex (got ${JSON.stringify(sha)})`);
    }
    refs[name] = 'sha256:' + sha;
  }
  return refs;
}
