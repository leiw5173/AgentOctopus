# Sandbox trusted images

This directory builds the two **trusted** images every AgentOctopus security
lane consumes (Plan 6 Task 6):

| Image | Local tag | Role |
|---|---|---|
| skill-runtime | `agentoctopus/skill-runtime:test` | Minimal shell-free Node runtime the skill executes in. **No `ENTRYPOINT`, no `CMD`** — the backend appends `ExecSpec.command` verbatim. |
| egress-proxy | `agentoctopus/egress-proxy:test` | Self-contained egress proxy. Single bundled server, no source mount, no `node_modules`. |

## The immutable-reference contract

Nothing in the sandbox references an image by a mutable tag. Every reference is
either `repo@sha256:<64 lowercase hex>` (a registry digest) or a bare
`sha256:<64 lowercase hex>` (a local image ID, what
`docker image inspect --format '{{.Id}}'` prints). The canonical rule is
`IMMUTABLE_IMAGE_RE` in `packages/sandbox/src/schema.ts`; it is consumed by
`ImmutableImageRefSchema`, the security harness (`requirePinnedImageRef`), the
build script, and `image-lock.ts`, so no layer can be looser or stricter than
another. Mutable tags (`:latest`, `:22-alpine`), bare names, and sentinels
(`MISSING`, `REPLACE`) are rejected at config-parse time and at build time.

## images.lock.json

Four required digest-pinned keys:

- **`nodeSourceBase`** — reviewed digest of the Node source image
  (`node:22-bookworm-slim`, glibc). Resolved from the registry **once** by the
  maintainer and pinned.
- **`distrolessBase`** — reviewed digest of the shell-free base
  (`gcr.io/distroless/cc-debian12`, glibc + libstdc++, no shell / package
  manager / compiler, ships the system CA store). Resolved once and pinned.
- **`runtimeImage`** / **`proxyImage`** — the **pushed** manifest-list digests
  of the two built images. These are rewritten atomically **only** by
  `security:images -- --push <registry>`. The committed placeholders are never
  consumed by the local lane (which uses the local image IDs below).

`src/image-lock.ts` reads this file, validates the two source bases against
`IMMUTABLE_IMAGE_RE` at import time, and exports `SANDBOX_NODE_SOURCE_BASE`,
`SANDBOX_DISTROLESS_BASE`, `SANDBOX_RUNTIME_IMAGE`, `SANDBOX_PROXY_IMAGE`, and
`assertImmutableImageRef()`. Core composes the canonical schema (which carries
these); it never reaches into the JSON or duplicates a digest literal.

## Building (local, no push)

```bash
pnpm --filter @agentoctopus/sandbox build            # compile dist/ (needed by the bundler smoke test)
pnpm --filter @agentoctopus/sandbox security:images  # bundle proxy + build both images
pnpm --filter @agentoctopus/sandbox security:images -- --print-env
```

`build-security-images.mjs`:

1. Validates `nodeSourceBase` / `distrolessBase` from the lock **before** any
   Docker call, and refuses to run on a mutable value.
2. Renders the Dockerfiles with those exact refs into a staging context — it
   never accepts an arbitrary `--build-arg BASE_IMAGE`.
3. Runs `bundle-egress-proxy.mjs` (esbuild → `build/egress-proxy-server.mjs` +
   a SHA-256 manifest, then a clean-cwd smoke test that the ready frame
   arrives with no workspace `node_modules`).
4. Builds both `:test` tags with `--pull=false` and BuildKit provenance + SBOM.
5. Prints immutable **local** image IDs:
   `OCTOPUS_TEST_RUNTIME_IMAGE=sha256:...` / `OCTOPUS_TEST_PROXY_IMAGE=sha256:...`.
   Export these for the security lane (`probeDocker` honors
   `OCTOPUS_TEST_RUNTIME_IMAGE`).

## Verifying

```bash
pnpm --filter @agentoctopus/sandbox exec vitest run tests/security/image-contract.test.ts
```

The contract test proves (against the real built images): no entrypoint/cmd +
exact-argv preservation; absence of `sh`/`bash`/`curl`/`wget`/`npm`/`npx`;
proxy boots from its own filesystem with no mounts and emits the ready frame;
all lock refs immutable and `SandboxConfigSchema` rejects mutable overrides; and
the runtime filesystem ships no shell / package manager / compiler.

## Maintainer push (NOT a local step)

The scope decision for this campaign is **local build only**. Pushing is a
separate maintainer/CI step:

```bash
pnpm --filter @agentoctopus/sandbox security:images -- --push ghcr.io/agentoctopus
```

This tags, pushes both images, resolves the pushed manifest-list digests, and
atomically rewrites **only** `runtimeImage` / `proxyImage` in the lock. It is
not run during local development or verification.

## Why cc-debian12 (not nodejs22-debian12)

- `gcr.io/distroless/nodejs22-debian12` ships its **own** Node **and** an
  `ENTRYPOINT ["/nodejs/bin/node"]`, which violates the runtime image's
  no-entrypoint contract. It is unusable as the runtime base.
- The runtime needs glibc + `libstdc++.so.6` (the `node:22-bookworm-slim`
  binary's `ldd` closure). `base-debian12` lacks `libstdc++`; `cc-debian12`
  provides the full closure while remaining shell-free with no package manager
  or compiler — verified by the image contract test.
- The Node binary is copied from the glibc `node:22-bookworm-slim` source so it
  links against the base's glibc (the musl `node:22-alpine` binary would not).
