# Sandbox security CI lanes

The reusable [`sandbox-security.yml`](../../../../.github/workflows/sandbox-security.yml) workflow separates security claims by the capabilities of each runner. A passing `security-gate` means all three mandatory jobs completed successfully; no hosted job is treated as evidence for a capability it cannot exercise.

## Runner and lane ownership

| Job | Runner | Required lanes and claims |
| --- | --- | --- |
| `hosted-docker-proxy` | `ubuntu-latest` | Harness and immutable-image contract; real Docker isolation and sidecar topology; egress proxy adversarial matrix; installation identity and snapshot integrity; MCP stdio over the Docker launcher. It does **not** claim Linux netns, nftables, or cgroup coverage. |
| `privileged-linux` | `[self-hosted, linux, x64, sandbox-privileged]` | Real Linux OS backend, named-netns proxy topology, nftables, and cgroup-v2 enforcement. `OCTOPUS_REQUIRE_PRIVILEGED_LINUX=1` makes unavailable capabilities fatal, and the Vitest JSON report must contain zero skipped, pending, todo, failed, or timed-out tests. |
| `macos-restricted` | `macos-14` | The real macOS restricted behavioral branch when `sandbox-exec` enforcement is available, or the explicit unavailable/full-isolation-rejected branch otherwise. It never claims full isolation on Darwin. |
| `security-gate` | `ubuntu-latest` | Requires the three jobs above to have `result == success`; it performs no additional isolation test itself. |

The production MCP Docker lane lives at `packages/core/tests/mcp-stdio-docker-e2e.test.ts`, where dependency direction permits using `SandboxRunner.bind()` and `SandboxMcpTransport` over a real `DockerBackend`. It therefore belongs to `hosted-docker-proxy` and is intentionally omitted from `privileged-linux`. The workflow must not describe that Docker-only test as MCP-over-Linux coverage. A future Linux MCP lane must parameterize the real launcher and prove the Linux variant before ownership changes.

## Privileged Linux runner prerequisites

Use a dedicated, ephemeral or tightly controlled CI host. Do not reuse a production host or a runner with production workloads or credentials.

One-time provisioning must:

1. Install Node.js 22/pnpm prerequisites plus Docker, `iproute2`, `nftables`, `util-linux`, `zstd`, `tar`, and a static-capable C toolchain used to produce reviewed OS artifacts.
2. Boot with unified cgroup v2 enabled. Create `/sys/fs/cgroup/agentoctopus-ci`, enable the required controllers in its parent, and delegate that subtree to the runner service account. Set `OCTOPUS_TEST_CGROUP_PARENT=/sys/fs/cgroup/agentoctopus-ci` for the job.
3. Grant only the runner service account the minimum capabilities needed by the real lane: `CAP_SYS_ADMIN` for namespaces/mount setup and `CAP_NET_ADMIN` for veth/netns/nftables mutation. Do not grant these capabilities to unrelated users or workloads.
4. Install and start Docker for the runner service. The runner must be able to create and remove containers and networks; mere presence of the Docker CLI is insufficient.
5. Provision the reviewed Linux OS artifacts outside the checkout and set `OCTOPUS_CI_RUNTIME_ARTIFACT_DIR` to that credential-free directory. It must contain exactly the expected runtime/helper inputs: `linux-node22.rootfs.tar.zst`, `linux-node22.manifest.json`, `os-helper`, and `os-helper.manifest.json`. Refresh these artifacts whenever their reviewed source or immutable runtime input changes. The workflow copies them into the ignored package runtime directory, and `security:probe-linux -- --require` verifies them before the lane runs.
6. Keep the runner credential-free apart from the short-lived GitHub Actions job token. Do not configure npm publishing credentials, cloud credentials, SSH deployment keys, production environment files, or access to production networks. The security workflow builds local images with `--print-env`; it never pushes an image.
7. Isolate the runner from production network paths and workloads. Prefer a disposable VM with no inbound service other than the Actions runner control channel.

The delegated cgroup parent is a runner contract. If the Linux implementation cannot create, read back, kill, and remove session cgroups under the delegated hierarchy, `probePrivilegedLinux()` or the mandatory Linux tests must fail; the job must never downgrade to restricted isolation or silently skip.

## Stale-resource cleanup

Run cleanup before and after every privileged job. The checked-in `security:cleanup-linux` command removes current OS-backend namespaces (`octn-*`), nftables tables (`oct_*`), and cgroups (`oct-*`) plus the documented legacy campaign prefixes `octns-*`, `oct-sbx-*`, and `octsbx-*`, best-effort. It scopes cgroup cleanup to `OCTOPUS_TEST_CGROUP_PARENT` when set. The workflow also removes Docker containers named `octopus-*` and Docker networks named `octopus-sbx-*`, `oct-sbx-*`, or `octsbx-*`.

Before deleting anything, cleanup is constrained to these dedicated prefixes; it must never enumerate and remove unrelated namespaces, cgroups, containers, or networks. Periodic host maintenance should verify that `/run/netns`, the delegated cgroup subtree, `nft list tables`, `docker ps -a`, and `docker network ls` contain no stale sandbox sessions.

Cleanup is defense in depth, not evidence of a passing lane. The tests must prove their own process trees and resources are reaped, and the `if: always()` cleanup step runs even after a failure or cancellation reaches job teardown.

## Release ownership

Release Preflight invokes this workflow as a reusable job for the exact preflight commit. The hosted job exposes the exact local `sha256:<64 lowercase hex>` runtime and proxy image IDs it tested. After the reusable job succeeds, Preflight queries its own current run attempt and records the exact API-visible reusable security gate job name, run ID/attempt, head SHA, and both immutable IDs in the uploaded artifact. Release Publish downloads that artifact and independently validates that recorded job before any npm publish command executes.

End-to-end workflow execution requires the provisioned self-hosted privileged Linux runner. Local macOS verification can parse workflow YAML and run fixture/unit tests, Docker lanes, and the macOS lane, but it cannot verify the privileged job, reusable-workflow job naming returned by GitHub's API, or release dispatch behavior.
