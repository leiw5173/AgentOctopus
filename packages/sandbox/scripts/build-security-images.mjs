#!/usr/bin/env node
/**
 * build-security-images.mjs — reproducible builder for the two trusted
 * sandbox images (Plan 6 Task 6):
 *
 *   agentoctopus/skill-runtime:test   (no ENTRYPOINT, no CMD — direct argv)
 *   agentoctopus/egress-proxy:test    (self-contained bundled server)
 *
 * Steps (brief §Step 1):
 *   1. Read + validate nodeSourceBase/distrolessBase from images.lock.json.
 *   2. Render the Dockerfiles with those EXACT refs into a staging context.
 *      Never accepts an arbitrary `--build-arg BASE_IMAGE`.
 *   3. Run bundle-egress-proxy.mjs.
 *   4. Build both local tags with --pull=false. Provenance/SBOM attestations
 *      are intentionally NOT requested: the default `docker` driver rejects
 *      them ("Attestation is not supported for the docker driver"), and the
 *      attestations only persist in a registry anyway — these :test images
 *      are local-only, consumed by the security lane via their immutable image
 *      ID. image-contract.test.ts asserts that ID is a digest, not any
 *      attestation metadata.
 *   5. Print shell assignments with the immutable LOCAL image IDs:
 *        OCTOPUS_TEST_RUNTIME_IMAGE=sha256:...
 *        OCTOPUS_TEST_PROXY_IMAGE=sha256:...
 *   6. With `--push <registry>` (MAINTAINER/CI step — NOT run locally), push
 *      both and atomically rewrite ONLY runtimeImage/proxyImage in the lock.
 *   7. Refuse to run if the lock has a mutable value or an inspect ref that is
 *      not a digest.
 *
 * `--print-env` prints only the env assignments (for CI capture).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const LOCK_PATH = path.join(PKG_ROOT, 'images', 'images.lock.json');
const BUNDLE_SCRIPT = path.join(PKG_ROOT, 'scripts', 'bundle-egress-proxy.mjs');
const BUNDLE_OUT = path.join(PKG_ROOT, 'build', 'egress-proxy-server.mjs');

const RUNTIME_TAG = 'agentoctopus/skill-runtime:test';
const PROXY_TAG = 'agentoctopus/egress-proxy:test';

// Same immutable-ref rule as IMMUTABLE_IMAGE_RE (schema.ts). Lowercase only.
const IMMUTABLE_RE =
  /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@)?sha256:[0-9a-f]{64}$/;
const MUTABLE_HINT = /MISSING|REPLACE|latest/i;

function die(msg, code = 1) {
  console.error(`build-security-images: ERROR: ${msg}`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { push: null, printEnv: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue; // tolerate a literal separator pnpm may forward
    if (a === '--push') {
      args.push = argv[++i];
      if (!args.push) die('--push requires a registry argument');
    } else if (a === '--print-env') {
      args.printEnv = true;
    } else {
      die(`unknown argument: ${a}`);
    }
  }
  return args;
}

async function readLock() {
  let raw;
  try {
    raw = await fs.readFile(LOCK_PATH, 'utf8');
  } catch (err) {
    die(`cannot read ${LOCK_PATH}: ${err.message}`);
  }
  let lock;
  try {
    lock = JSON.parse(raw);
  } catch (err) {
    die(`${LOCK_PATH} is not valid JSON: ${err.message}`);
  }
  return lock;
}

function assertImmutable(name, value) {
  if (typeof value !== 'string' || !IMMUTABLE_RE.test(value)) {
    die(`lock ${name} is mutable or malformed (must be repo@sha256:<64hex> or sha256:<64hex>): ${JSON.stringify(value)}`);
  }
  if (MUTABLE_HINT.test(value)) {
    die(`lock ${name} contains a forbidden mutable/sentinel hint: ${value}`);
  }
  return value;
}

function renderRuntimeDockerfile(nodeBase, distrolessBase) {
  return `# Rendered by build-security-images.mjs from images.lock.json — do not edit refs by hand.
FROM ${nodeBase} AS node-source
FROM ${distrolessBase}
COPY --from=node-source /usr/local/bin/node /usr/local/bin/node
USER 65532:65532
WORKDIR /skill
ENV NODE_ENV=production PATH=/usr/local/bin
# Deliberately NO ENTRYPOINT and NO CMD: DockerBackend appends ExecSpec.command verbatim.
`;
}

function renderProxyDockerfile(nodeBase, distrolessBase) {
  return `# Rendered by build-security-images.mjs from images.lock.json — do not edit refs by hand.
FROM ${nodeBase} AS node-source
FROM ${distrolessBase}
COPY --from=node-source /usr/local/bin/node /usr/local/bin/node
COPY egress-proxy-server.mjs /app/egress-proxy-server.mjs
USER 65532:65532
WORKDIR /app
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/node", "/app/egress-proxy-server.mjs"]
`;
}

async function dockerBuild({ contextDir, dockerfile, tag }) {
  // --pull=false: build only from the rendered Dockerfile refs; never pull a
  // mutable tag. No provenance/SBOM: the default `docker` driver does not
  // support attestations and they don't persist for local images (see header).
  const args = [
    'build',
    '--pull=false',
    '-f', dockerfile,
    '-t', tag,
    contextDir,
  ];
  try {
    await execFileAsync('docker', args, { maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    die(`docker build ${tag} failed: ${err.stderr?.toString() ?? err.message}`);
  }
}

async function imageId(tag) {
  let out;
  try {
    ({ stdout: out } = await execFileAsync('docker', ['image', 'inspect', '--format', '{{.Id}}', tag]));
  } catch (err) {
    die(`docker image inspect ${tag} failed: ${err.stderr?.toString() ?? err.message}`);
  }
  const id = out.trim();
  if (!IMMUTABLE_RE.test(id)) {
    die(`inspect ref for ${tag} is not a digest: ${JSON.stringify(id)}`);
  }
  return id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const lock = await readLock();

  // Step 1: validate source bases before invoking Docker.
  const nodeBase = assertImmutable('nodeSourceBase', lock.nodeSourceBase);
  const distrolessBase = assertImmutable('distrolessBase', lock.distrolessBase);

  // Step 3: bundle the proxy server (also smoke-tests the bundle).
  try {
    await execFileAsync(process.execPath, [BUNDLE_SCRIPT], { maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    die(`bundle-egress-proxy failed: ${err.stderr?.toString() ?? err.message}`);
  }
  try {
    await fs.access(BUNDLE_OUT);
  } catch {
    die(`expected bundle at ${BUNDLE_OUT} after bundling`);
  }

  // Step 2 + 4: stage contexts with rendered Dockerfiles, then build.
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'oct-secimg-'));
  try {
    // Runtime context.
    const rtDir = path.join(staging, 'runtime');
    await fs.mkdir(rtDir, { recursive: true });
    const rtDockerfile = path.join(rtDir, 'Dockerfile');
    await fs.writeFile(rtDockerfile, renderRuntimeDockerfile(nodeBase, distrolessBase));
    await dockerBuild({ contextDir: rtDir, dockerfile: rtDockerfile, tag: RUNTIME_TAG });

    // Proxy context (needs the bundle in-context).
    const pxDir = path.join(staging, 'proxy');
    await fs.mkdir(pxDir, { recursive: true });
    const pxDockerfile = path.join(pxDir, 'Dockerfile');
    await fs.writeFile(pxDockerfile, renderProxyDockerfile(nodeBase, distrolessBase));
    await fs.copyFile(BUNDLE_OUT, path.join(pxDir, 'egress-proxy-server.mjs'));
    await dockerBuild({ contextDir: pxDir, dockerfile: pxDockerfile, tag: PROXY_TAG });
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }

  // Step 5: immutable local IDs.
  const runtimeId = await imageId(RUNTIME_TAG);
  const proxyId = await imageId(PROXY_TAG);

  // Step 6: optional maintainer push (rewrites only runtimeImage/proxyImage).
  let pushedRuntime = null;
  let pushedProxy = null;
  if (args.push) {
    const registry = args.push.replace(/\/+$/, '');
    const rtRef = `${registry}/skill-runtime:test`;
    const pxRef = `${registry}/egress-proxy:test`;
    for (const [tag, ref] of [[RUNTIME_TAG, rtRef], [PROXY_TAG, pxRef]]) {
      try {
        await execFileAsync('docker', ['tag', tag, ref]);
        await execFileAsync('docker', ['push', ref], { maxBuffer: 64 * 1024 * 1024 });
      } catch (err) {
        die(`push ${ref} failed: ${err.stderr?.toString() ?? err.message}`);
      }
    }
    // Resolve the pushed manifest-list digests.
    const digestOf = async (ref) => {
      const { stdout } = await execFileAsync('docker', ['buildx', 'imagetools', 'inspect', ref, '--format', '{{json .Manifest}}']);
      const d = JSON.parse(stdout).digest;
      if (!/^sha256:[0-9a-f]{64}$/.test(d)) die(`pushed digest for ${ref} malformed: ${d}`);
      return d;
    };
    pushedRuntime = `${registry}/skill-runtime@${await digestOf(rtRef)}`;
    pushedProxy = `${registry}/egress-proxy@${await digestOf(pxRef)}`;

    // Atomic lock rewrite of ONLY the two pushed slots.
    const next = { ...lock, runtimeImage: pushedRuntime, proxyImage: pushedProxy };
    const tmp = `${LOCK_PATH}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2) + '\n');
    await fs.rename(tmp, LOCK_PATH);
  }

  const envLines = [
    `OCTOPUS_TEST_RUNTIME_IMAGE=${runtimeId}`,
    `OCTOPUS_TEST_PROXY_IMAGE=${proxyId}`,
  ];

  if (args.printEnv) {
    for (const l of envLines) console.log(l);
  } else {
    console.log('build-security-images: OK');
    console.log(`  runtime: ${RUNTIME_TAG} -> ${runtimeId}`);
    console.log(`  proxy:   ${PROXY_TAG} -> ${proxyId}`);
    if (pushedRuntime) console.log(`  pushed runtimeImage: ${pushedRuntime}`);
    if (pushedProxy) console.log(`  pushed proxyImage:   ${pushedProxy}`);
    console.log('');
    console.log('# Local immutable image IDs (export for the security lane):');
    for (const l of envLines) console.log(l);
  }
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
