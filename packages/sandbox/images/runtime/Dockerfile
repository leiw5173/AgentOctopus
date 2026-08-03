# Trusted skill-runtime image (Plan 6 Task 6).
#
# Base refs are pinned by digest in images.lock.json and rendered/verified by
# scripts/build-security-images.mjs — it injects the exact refs at build time
# and never accepts an arbitrary --build-arg BASE_IMAGE. The refs below mirror
# the committed lock; the build script is authoritative.
#
# The final stage is the shell-free distroless cc base (glibc, libstdc++), so
# the image ships no shell, no package manager, no network client, and no
# compiler. The Node binary's glibc closure (ld-linux, libc, libm, libdl,
# libpthread, libgcc_s, libstdc++) is satisfied by the base; verified by the
# image contract test.
FROM node@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS node-source
FROM gcr.io/distroless/cc-debian12@sha256:e8e7ee4b8b106d4c5fde9e422a321b2b8a2d5cca546c97adcce927f3e1d36e36
COPY --from=node-source /usr/local/bin/node /usr/local/bin/node
# octopus-boot: read-only, root-owned bootstrap + vendored undici. Mode 0555/0444
# so the runtime uid (65534) can read but never write. Build context stages
# bootstrap.cjs and undici/ under octopus-boot/.
COPY --chmod=0555 octopus-boot/ /opt/octopus-boot/
USER 65534:65534
WORKDIR /skill
ENV NODE_ENV=production PATH=/usr/local/bin
# Deliberately NO ENTRYPOINT and NO CMD: DockerBackend appends ExecSpec.command
# verbatim, so the runtime must not inject its own argv.
