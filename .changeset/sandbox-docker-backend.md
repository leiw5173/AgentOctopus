---
"@agentoctopus/sandbox": minor
---

Add `DockerBackend` — the full-isolation sandbox backend. Runs the immutable content-addressed snapshot in a hardened container on an internal-only Docker network (no internet route), with memory/CPU/PID/ulimit caps, dropped capabilities, read-only rootfs, scrubbed env, output caps, and guaranteed container destruction on timeout/cleanup. Includes a docker CLI wrapper and internal-network lifecycle helpers.
