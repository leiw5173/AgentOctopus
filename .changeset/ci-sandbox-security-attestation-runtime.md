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
   subnets"). `createEgressNetwork` now creates the network with
   `--subnet 10.201.0.0/24` (a private range outside Docker's default
   172.17-172.29 auto-allocation pool). The test's `pickStaticIp` reads the
   subnet via `network inspect`, so it auto-adapts.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
