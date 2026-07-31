---
'@agentoctopus/sandbox': patch
---

fix(ci): drop unsupported attestation flags + wire runtime image into producer lane

Two independent root causes for the `Sandbox Security` workflow failing on
first run (hosted-docker-proxy + produce-linux-artifacts → security-gate red):

1. `build-security-images.mjs` built the local :test images with
   `docker build --provenance=true --sbom=true`. The CI runner's default
   `docker` driver rejects attestation ("Attestation is not supported for
   the docker driver"). The flags are untested (image-contract asserts
   only the immutable digest + entrypoint/cmd) and meaningless for local
   unpushed images (attestations persist in a registry, not locally).
   Removed the flags.

2. `produce-linux-artifacts` ran `build-runtime-rootfs.mjs`, which
   fail-closed-exits when `OCTOPUS_RUNTIME_IMAGE` is unset, and the job
   never built the package (the script's self-check imports
   `../dist/os/rootfs.js`; `build-os-helper.mjs` imports
   `dist/os/helper-build.js`). Mirrored the hosted lane: build the package,
   run `security:images -- --print-env`, capture the immutable runtime
   image ID, and export it as `OCTOPUS_RUNTIME_IMAGE`.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
