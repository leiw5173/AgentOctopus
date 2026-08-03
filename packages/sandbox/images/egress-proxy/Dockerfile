# Trusted egress-proxy image (Plan 6 Task 6).
#
# Base refs are pinned by digest in images.lock.json and rendered/verified by
# scripts/build-security-images.mjs. The server is a single self-contained
# esbuild bundle (scripts/bundle-egress-proxy.mjs -> build/egress-proxy-server.mjs)
# with NO external runtime imports beyond Node built-ins — so the image needs
# no source bind mount and no production node_modules.
#
# The build script copies the bundle into the build context as
# egress-proxy-server.mjs before invoking docker build.
FROM node@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS node-source
FROM gcr.io/distroless/cc-debian12@sha256:e8e7ee4b8b106d4c5fde9e422a321b2b8a2d5cca546c97adcce927f3e1d36e36
COPY --from=node-source /usr/local/bin/node /usr/local/bin/node
COPY egress-proxy-server.mjs /app/egress-proxy-server.mjs
USER 65532:65532
WORKDIR /app
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/node", "/app/egress-proxy-server.mjs"]
