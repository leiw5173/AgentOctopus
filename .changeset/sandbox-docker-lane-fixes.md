---
"@agentoctopus/sandbox": patch
---

Fix two Docker-backend defects surfaced by the Plan 6 Docker security lane:

- Mount the immutable snapshot and session CA with `--mount type=bind` instead of `-v`. The content-addressed snapshot root contains a colon (`<store>/sha256:<hex>`), which `-v host:guest:ro` parses as a field separator and rejects with "too many colons", so no runtime container could start.
- Wait for the freshly `docker run`-ed egress-proxy container to reach the running state before `docker network connect`. `docker run` returns before the daemon registers the container, so an immediate connect raced the daemon and failed with "No such container", making proxy launch fail on fast hosts.
