---
"@agentoctopus/sandbox": patch
---

tests(security): resolve the privileged-lane node executable path from a single `LANE_NODE` constant (`/usr/local/bin/node`) instead of hardcoding `/usr/bin/node`. The `linux-node22` runtime rootfs ships node at `/usr/local/bin/node` (per `runtimeProfile.osRuntime.nodePath`); several privileged-lane probes hardcoded `/usr/bin/node`, which does not exist in the rootfs and made the helper's `execve` fail ENOENT once the credential-drop fixes (mapped-root) finally let the helper reach `exec`. This was a latent test bug, masked while the helper died earlier at the credential drop. A shared constant keeps the probe default and the explicit `command:` arrays in `linux-lane.test.ts` / `linux-topology.test.ts` consistent with the runtime manifest.
