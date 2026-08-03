/**
 * image-lock.ts — the single in-package reader of `images/images.lock.json`.
 *
 * The lock carries four immutable references (Plan 6 Task 6):
 *   - `nodeSourceBase` / `distrolessBase` — reviewed source-image digests,
 *     resolved from the registry ONCE by the maintainer and pinned here.
 *   - `runtimeImage` / `proxyImage` — the PUSHED manifest-list digests of the
 *     two built images. These are rewritten atomically ONLY by
 *     `security:images -- --push <registry>` (a maintainer/CI step). For a
 *     local build the immutable reference is the local image ID
 *     (`docker image inspect --format '{{.Id}}' agentoctopus/skill-runtime:test`),
 *     supplied to the security lane via OCTOPUS_TEST_RUNTIME_IMAGE /
 *     OCTOPUS_TEST_PROXY_IMAGE — never this placeholder.
 *
 * Every value is validated against the canonical immutable-image regex
 * (`IMMUTABLE_IMAGE_RE`, schema.ts) at module load, so a hand-edited lock with
 * a mutable tag fails closed the moment the package is imported.
 *
 * Leaf-package rule: Node stdlib (`node:fs`, `node:url`, `node:path`) + this
 * package's own schema.js. No @agentoctopus/* imports.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { IMMUTABLE_IMAGE_RE } from './schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/image-lock.js -> package root is one level up; images/ lives at the
// package root (not under dist/), so resolve from the package root.
const LOCK_PATH = join(HERE, '..', 'images', 'images.lock.json');

export interface ImageLock {
  schemaVersion: number;
  nodeSourceBase: string;
  distrolessBase: string;
  runtimeImage: string;
  proxyImage: string;
}

/**
 * Assert a value is an immutable image reference (`repo@sha256:<64hex>` or a
 * bare local `sha256:<64hex>` image ID). Throws on any mutable form. This is
 * the same gate as `ImmutableImageRefSchema`, exposed as a plain function so
 * non-Zod callers (build scripts, harness) share one rule.
 */
export function assertImmutableImageRef(name: string, value: string): string {
  if (!IMMUTABLE_IMAGE_RE.test(value)) {
    throw new Error(
      `${name} must be an immutable image reference (repo@sha256:<64 lowercase hex> or sha256:<64 lowercase hex>); got mutable/invalid: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function loadLock(): ImageLock {
  let raw: string;
  try {
    raw = readFileSync(LOCK_PATH, 'utf8');
  } catch (err) {
    throw new Error(
      `image-lock: cannot read ${LOCK_PATH}: ${(err as Error).message}. ` +
        'The images lock is required for the sandbox image references.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`image-lock: ${LOCK_PATH} is not valid JSON: ${(err as Error).message}`);
  }
  const lock = parsed as ImageLock;
  // Validate the two source bases eagerly. runtimeImage/proxyImage are the
  // pushed-digest slots; they are validated by the build script before use and
  // may hold the never-consumed local placeholder in the committed lock.
  assertImmutableImageRef('nodeSourceBase', lock.nodeSourceBase);
  assertImmutableImageRef('distrolessBase', lock.distrolessBase);
  return lock;
}

const LOCK = loadLock();

/** Reviewed, registry-pinned digest of the Node source image (glibc). */
export const SANDBOX_NODE_SOURCE_BASE = LOCK.nodeSourceBase;
/** Reviewed, registry-pinned digest of the shell-free distroless base. */
export const SANDBOX_DISTROLESS_BASE = LOCK.distrolessBase;
/** Pushed manifest-list digest of the runtime image (local placeholder until pushed). */
export const SANDBOX_RUNTIME_IMAGE = LOCK.runtimeImage;
/** Pushed manifest-list digest of the egress-proxy image (local placeholder until pushed). */
export const SANDBOX_PROXY_IMAGE = LOCK.proxyImage;
