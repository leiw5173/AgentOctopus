---
'@agentoctopus/sandbox': patch
---

Tighten CI sandbox test gates + fix a cross-platform fixture bug:

- New `probeDockerImages()` gate (stricter than `probeDocker()`): the
  docker-lane / docker-topology / image-contract suites now probe for the
  actual trusted images they run (env digest refs, or the local `:test`
  fallback) instead of only daemon reachability. On plain runners where the
  daemon is reachable via hello-world but the images are absent, the suites
  skip cleanly instead of failing with spurious exit-125 errors.
- OS smoke suites (os-netns, os-backend-linux-smoke) now require euid 0 in
  addition to Linux, so unprivileged Linux CI runners skip instead of failing
  on `Permission denied` / capability-probe false.
- Fixed the docker-lane `it.each` case to gate via `it.skipIf` (vitest v1's
  `it.each` never passes a test context, so `ctx.skip()` crashed), and
  corrected the misleading `it.each` context guidance in linux-lane-setup.ts.
- Fixed vm-helper-build.test.ts to resolve `libkrun.so` / `libkrunfw.so` on
  Linux instead of hardcoding `.dylib` (the runtime image-lane fixture was
  wrong on every non-macOS host).
