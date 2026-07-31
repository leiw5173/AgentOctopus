---
'@agentoctopus/sandbox': patch
---

fix(ci): drop unsupported attestation flags + wire runtime image + fixed egress subnet

Three root causes for the `Sandbox Security` workflow failing on its first run
(hosted-docker-proxy + produce-linux-artifacts → security-gate red). Two were
revealed directly by run #1; the third was latent and surfaced only after #1
unblocked the hosted lane past the image-build step.

1. `build-security-images.mjs` built the local :test images with
   `docker build --provenance=true --sbom=true`. The CI runner's default
   `docker` driver rejects attestation ("Attestation is not supported for
   the docker driver"). The flags are untested (image-contract asserts
   only the immutable digest + entrypoint/cmd) and meaningless for local
   unpushed images (attestations persist in a registry, not locally).
   Removed the flags.

2. `produce-linux-artifacts` ran `build-runtime-rootfs.mjs`, which
   fail-closed-exits when `OCTOPUS_RUNTIME_IMAGE` is unset, and the job never
   built the package (the script's self-check imports `../dist/os/rootfs.js`;
   `build-os-helper.mjs` imports `dist/os/helper-build.js`). Mirrored the
   hosted lane: build the package, run `security:images -- --print-env`,
   capture the immutable runtime image ID, and export it as
   `OCTOPUS_RUNTIME_IMAGE`. The capture loop also ignores the emitted proxy
   line (the producer exports only the runtime rootfs).

3. `createEgressNetwork` created the egress bridge with a bare
   `docker network create <name>` (auto-assigned subnet). The
   docker-topology test attaches the upstream fixture with `docker run
   --network <egress> --ip <ip>`, and Docker only honors `--ip` on networks
   created with an explicit `--subnet` ("user specified IP address is
   supported only when connecting to networks with user configured
   subnets"). `createEgressNetwork` now derives a per-session `10.b.c.0/24`
   subnet from the network name's session token via FNV-1a (a private range
   outside Docker's default 172.17-172.29 auto-allocation pool, and distinct
   per session so concurrent vitest files don't collide). The test's
   `pickStaticIp` reads the subnet via `network inspect`, so it auto-adapts.

4. The runtime rootfs producer/verifier rejected ALL symlinks, but the
   exported distroless runtime image contains 377 standard symlinks
   (`etc/mtab -> /proc/mounts`, `libstdc++.so.6 -> libstdc++.so.6.0.30`,
   ~370 `usr/share/zoneinfo/*`, etc.). Strict rejection made it impossible
   to produce a rootfs from a real image — the script had never run against
   one before. Both the producer (`build-runtime-rootfs.mjs`) and verifier
   (`verifyRuntimeArtifact` in `src/os/rootfs.ts`) now record symlinks as
   `kind:'symlink'` + `linkTarget` (mirroring the existing `snapshot.ts`
   `walk()` precedent) and reject any symlink whose target resolves outside
   the rootfs (path-traversal vector). A producer pre-pass strips
   runtime-only entries with no static representation — root-level
   `proc`/`dev`/`sys` (mounted at chroot time by `helper.c`) and any
   escaping symlink (caught by generic escape-check, never by name). The
   ELF closure now resolves DT_NEEDED sonames through symlinks (e.g.
   `libstdc++.so.6`), matching dynamic-loader behavior.

5. The runtime image ships node at `/usr/local/bin/node` (per the
   `build-security-images.mjs` Dockerfile), but the rootfs verifier's
   `nodePath` enum and the producer's `nodeCandidates` only accepted
   `/usr/bin/node` or `/bin/node` — contradicting `schema.ts` and
   `backend.ts`, which already allow `/usr/local/bin/node`. The symlink
   failure (#4) had masked this since the producer never reached the node
   lookup. Both sites now accept `/usr/local/bin/node`, and the stale
   `linux-lane-setup.ts` comment claiming the image ships node at
   `/usr/bin/node` is corrected.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
