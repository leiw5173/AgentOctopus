---
"@agentoctopus/sandbox": minor
---

Add reproducible, immutable trusted runtime and egress-proxy images (Plan 6 Task 6). Pins `nodeSourceBase`/`distrolessBase` digests in `images/images.lock.json`, adds `src/image-lock.ts` (validated against the canonical `IMMUTABLE_IMAGE_RE`), and ships build/bundle/probe/cleanup scripts plus an executable image contract test. The runtime image is shell-free with no `ENTRYPOINT`/`CMD`; the proxy image is a single self-contained esbuild bundle. `SandboxConfigSchema` now validates `proxy.artifact` with the same immutable-reference regex as `docker.image`, rejecting mutable tags at config-parse time. Local build only; pushing is a separate maintainer step.
