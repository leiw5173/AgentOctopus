# @agentoctopus/sandbox

## 0.9.0

### Minor Changes

- 6bc7cd0: feat: hermes E2E acceptance gate — debug telemetry, per-skill output validators, and executionId correlation

  - `@agentoctopus/core`: ExecutionContext telemetry (traceId/executionId propagation through Router→Executor→SandboxRunner); per-skill outputValidators map on Executor (skill-name-keyed lookup, backward-compatible with single outputValidator); debugEndpoints config section; fix executionId sharing so adapter.completed and sandbox.completed events use the SAME id per execute() call.
  - `@agentoctopus/gateway`: admin debug endpoint GET /agent/debug/last-run; DebugTelemetryBuffer (per-request RunRecord aggregation by traceId, executionId-based runs[] merge, ring-buffer eviction); /ask correlation-key extraction ([trace: oct-e2e-<uuid>]) with exactly-one terminal emission; per-skill validators for weather (temperature pattern) and ip-lookup (IPv4 pattern).
  - `@agentoctopus/cli`: `octopus doctor` subcommand for environment diagnostics.
  - `@agentoctopus/sandbox`: bootstrap egress proxy integration; vendored undici for proxy HTTP forwarding.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>

- 4876e12: feat(sandbox): VM block-image build orchestration (snapshot + CA)
- c83e5c1: Trusted runtime profiles may declare darwinRuntime.manifestPath identifying the verified macOS Node runtime closure; BackendPrepareOptions now carries expectedSnapshotDigest; the runner rejects runtime-profile/backend-kind mismatches (RUNTIME_BACKEND_MISMATCH) before topology or proxy launch.
- Add `DockerBackend` — the full-isolation sandbox backend. Runs the immutable content-addressed snapshot in a hardened container on an internal-only Docker network (no internet route), with memory/CPU/PID/ulimit caps, dropped capabilities, read-only rootfs, scrubbed env, output caps, and guaranteed container destruction on timeout/cleanup. Includes a docker CLI wrapper and internal-network lifecycle helpers.
- 395a999: Add `DockerBackend` — the full-isolation sandbox backend. Runs the immutable content-addressed snapshot in a hardened container on an internal-only Docker network (no internet route), with memory/CPU/PID/ulimit caps, dropped capabilities, read-only rootfs, scrubbed env, output caps, and guaranteed container destruction on timeout/cleanup. Includes a docker CLI wrapper and internal-network lifecycle helpers.
- Add the trusted egress proxy with strict absolute-URL/userinfo/scheme/port policy, exact/wildcard host and high-risk credential matching, explicit private-literal grants with DNS-answer SSRF rejection, lowercase overwrite-only credential injection, raw-header smuggling checks, DNS-pinned sockets, validated and test-injectable upstream TLS, correct DNS/IP SANs, redirect origin/port re-evaluation, bounded idempotent HTTP+CONNECT accounting, sanitized buffered response framing, authenticated one-shot secret IPC, and topology-neutral in-process/Docker/Linux-static launcher handles.
- 56d6b8b: Add the trusted egress proxy with strict absolute-URL/userinfo/scheme/port policy, exact/wildcard host and high-risk credential matching, explicit private-literal grants with DNS-answer SSRF rejection, lowercase overwrite-only credential injection, raw-header smuggling checks, DNS-pinned sockets, validated and test-injectable upstream TLS, correct DNS/IP SANs, redirect origin/port re-evaluation, bounded idempotent HTTP+CONNECT accounting, sanitized buffered response framing, authenticated one-shot secret IPC, and topology-neutral in-process/Docker/Linux-static launcher handles.
- a093b07: Converge every untrusted skill execution and network path on fail-closed sandbox backends. Adds canonical trusted/request schemas, immutable snapshot-only invocation payloads, backend-aware egress proxy and CA topology, persistent duplex sandbox processes for MCP, digest-pinned runtime profiles, stable installation identities, and secret-provider isolation. Removes host subprocess/network/bin-install fallbacks and unsupported legacy OpenShell behavior.
- 4360716: Add `@agentoctopus/sandbox` leaf package: core domain DTOs, canonical policy/grant Zod schemas, host/path matching, requested∩granted PolicyResolver, immutable content-addressed snapshot builder, SecretProvider interface, and the fail-closed SandboxBackend interface + selector. Foundation for the sandbox isolation feature (see docs/superpowers/specs/2026-07-27-sandbox-design.md).
- 763827c: Enforce external proxy ownership in the Linux OS sandbox backend. The proxy lifecycle is owned solely by the canonical `SandboxRunner` + `DefaultProxyLauncher`, which launches exactly one proxy per session and closes its handle after backend teardown. `OsSandboxBackend` now consumes only the launcher-supplied `proxyAddr`/`caBundlePath`: `prepare()` validates those coordinates against the topology carrier (host/port match, rejecting before nft authorization) and trusts the orchestrator for readiness — no liveness probe in `prepare()`, no `ProxyHandle` storage, and no proxy launch or close. `cleanup()` removes backend runtime/topology only (active child, skill cgroup, rootfs, netns) and never closes an externally owned proxy. The backend's own trusted PID ceiling stays the production constant `64`. The egress proxy address/port allow rule and read-only snapshot/CA invariants are unchanged; macOS remains `restricted`.

  The OS netns ruleset now declares a forward-hook default-drop chain (`chain forward { type filter hook forward priority 0; policy drop; }`, no accept rule inside) in BOTH the initial and the authorized nft tables — forwarded namespace traffic is dropped by policy without enabling IP forwarding (the `net.ipv4.ip_forward` sysctl is never mutated). The authorized table re-declares the forward chain because the atomic table replace drops the whole table. The `nft -j list` read-back walker now recognizes chain entries and normalizes priority via `Number(chain.prio ?? chain.priority) === 0` (tolerating numeric and string `"0"`, and the `priority`-key fallback), failing closed with a precise reason when the forward chain is missing, malformed, has the wrong priority/policy/hook/type, or carries an accept rule. No NAT chain is declared and the NAT-negative invariant is retained.

  The OS backend now honors a delegated cgroup v2 root via the `cgroupRoot` option on `OsSandboxBackendOptions`, with the `OCTOPUS_TEST_CGROUP_PARENT` env var as a fallback and `/sys/fs/cgroup` as the default. The root is validated fail-closed (must exist and be a directory) before `createLimitedCgroup` is called — if the root is absent or not a directory, `prepare()` throws and no cgroup is created. The `cgroupRoot` is passed through to `createLimitedCgroup` (which already accepted it) so the skill cgroup lands under the delegated hierarchy. The advisory `proxyCgroupPath` on the carrier is joined under the same root for consistency. A read-only `skillCgroupPath` getter on the concrete `OsSandboxBackend` class exposes the skill cgroup path (sourced from the `CgroupHandle.path` after `prepare()`, cleared to `undefined` after `cleanup()`); it is intentionally NOT on the `SandboxBackend` interface — the privileged Linux lane downcasts or uses the concrete type to access it.

  The privileged Linux security lane is authored and wired into CI. The security harness probe (`probePrivilegedLinux`) now uses the canonical reviewed artifact names (`linux-node22.manifest.json`, `os-helper.manifest.json`, `os-helper` under `OCTOPUS_OS_PROBE_MANIFEST_ROOT`) and reports unavailable-with-reason for the old generic names, so stale provisioning is never silently trusted. New `linux-lane-setup.ts` drives the real `OsSandboxBackend` through the canonical orchestration order (probe-before-rank `selectBackend` → `prepareTopology` → external `DefaultProxyLauncher.launch` → `verifySnapshot` → `prepare`), exposing the concrete-class `skillCgroupPath` and tearing down in runner order (process → backend runtime/topology → external proxy). `linux-lane.test.ts` covers real containment (host canary, nft default-drop network denial, ungranted-upstream proxy denial, env hygiene, output cap, timeout cgroup kill via `cgroup.procs`/`cgroup.events`, finite memory/cpu limits, `pids.max=64` fork-bomb bound, fail-closed cgroup-root rejection); `linux-topology.test.ts` covers the /32-only route, read-only session CA proven via `nsenter` against the real PID from `cgroup.procs`, HTTPS through the proxy to a granted upstream, the structural nft forward default-drop chain with no NAT, exactly-one proxy listener (`ss -ltnH` + EADDRINUSE rebind), and full teardown absence. The lane is gated by `OCTOPUS_REQUIRE_PRIVILEGED_LINUX=1` (unavailable capability is fatal, never skipped; zero-skip enforced via the Vitest JSON report) — intentionally distinct from the portable per-file `OCTOPUS_REQUIRE_OS_SANDBOX=1` smoke gate. On non-Linux hosts the lane compiles and skips; the mandatory privileged run is CI-owned (`produce-linux-artifacts` builds the reviewed artifacts with a C toolchain; `privileged-linux` restores them from `OCTOPUS_CI_RUNTIME_ARTIFACT_DIR` or the same-run artifact and fails closed when any canonical file is absent).

- 9b792d8: Sandbox run/session outputs now carry the full machine-readable SandboxResultMeta from the backend result verbatim. run() awaits cleanup before returning and downgrades to isolationLevel 'none' on ContainmentCleanupError; persistent sessions expose resultMeta, definitive only after close(). Session-dir and proxy-close failures surface as degradation reasons without downgrading isolation.
- 651f879: Add reproducible, immutable trusted runtime and egress-proxy images (Plan 6 Task 6). Pins `nodeSourceBase`/`distrolessBase` digests in `images/images.lock.json`, adds `src/image-lock.ts` (validated against the canonical `IMMUTABLE_IMAGE_RE`), and ships build/bundle/probe/cleanup scripts plus an executable image contract test. The runtime image is shell-free with no `ENTRYPOINT`/`CMD`; the proxy image is a single self-contained esbuild bundle. `SandboxConfigSchema` now validates `proxy.artifact` with the same immutable-reference regex as `docker.image`, rejecting mutable tags at config-parse time. Local build only; pushing is a separate maintainer step.
- Add the release-blocking sandbox security matrix and immutable runtime supply chain. The runtime image has no entrypoint or shell/network clients and executes direct argv; the egress-proxy image is self-contained. Docker, privileged Linux, proxy, persistent MCP, identity/snapshot, and macOS restricted/fail-closed lanes now prove host-canary isolation, proxy-only egress, credential scoping, redirect/framing/smuggling/DNS/TLS defenses, resource and process-tree cleanup, and digest sensitivity. Release preflight and publish require successful security results for the exact release SHA and immutable image digests.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>

- e45c517: Add the release-blocking sandbox security matrix and immutable runtime supply chain. The runtime image has no entrypoint or shell/network clients and executes direct argv; the egress-proxy image is self-contained. Docker, privileged Linux, proxy, persistent MCP, identity/snapshot, and macOS restricted/fail-closed lanes now prove host-canary isolation, proxy-only egress, credential scoping, redirect/framing/smuggling/DNS/TLS defenses, resource and process-tree cleanup, and digest sensitivity. Release preflight and publish require successful security results for the exact release SHA and immutable image digests.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>

- c449e9d: Add VmSandboxBackend orchestrator (probe/prepareTopology/prepare/spawn/run/cleanup) implementing the SandboxBackend contract using VmEnginePort + VmImageBuilderPort. Wires Tasks 1-8: resolves/asserts rootfs qualification, builds skill + CA block images, encodes the CBOR launch-spec into bootstrapArgv, and enforces fail-closed cleanup via ContainmentCleanupError when VmInstance.kill fails (memoized). Includes collectBoundedVmResult (output cap + timeout -> vm.kill) and L2 fake-driven tests (FakeVmEngine, FakeVmImageBuilder).
- a27bf3d: Add `vm` config block (rootfs, memMib, cpus, kernelCmdline, libkrunAbi pinned to v1.19.4), `vmRuntime` field on runtime profiles (with required `executables` map), and `'vm'` to the `BackendKind` union + `defaultBackend` enum to register the VM (libkrun) sandbox backend in config.
- 000a440: Add a lightweight VM sandbox backend (libkrun v1.19.4 + Hypervisor.framework)
  for `full` isolation without Docker Desktop dependency. Skills run inside a
  Linux VM with the snapshot exposed as a read-only ext4 block image (NOT
  virtiofs — libkrun treats guest and VMM as the same host security context),
  built by a deterministic cross-platform image-builder (no system mkfs.ext4 /
  Docker / Homebrew dependency for skill block images; the rootfs uses standard
  `mke2fs` since it must carry a real ~30 MiB node binary that exceeds the C
  writer's single-block-group capacity) with descriptor-relative traversal
  (openat + fstat on the fd, O_NOFOLLOW, explicit "."/".." rejection — no
  lstat→open swap race) and a TOCTOU-closing digest re-compute. The
  image-builder port exposes two methods: buildSnapshotImage (directory +
  canonical snapshot digest) and buildSingleFileImage (single file + file
  digest, for the CA bundle).

  libkrun runs in a dedicated signed+entitled helper subprocess
  (krun_start_enter terminates its caller) using the real v1.19.4 API
  (krun_set_vm_config(ctx, num_vcpus, ram_mib) — vCPUs before RAM, per the
  verified header signature + krun_disable_implicit_vsock +
  krun_add_vsock(tsi_features=0) + krun_add_vsock_port + krun_add_disk for
  block ids vda/vdb/vdc + krun_set_root_disk_remount("/dev/vda","ext4","ro")

  - krun_set_exec of a TRUSTED bootstrap /usr/libexec/octopus-vm-init +
    krun_set_workdir(ctx, "/") — workdir pinned to "/", NOT the workload cwd,
    because /skill is not mounted until the bootstrap runs). The trusted
    bootstrap (PID 1) mounts /dev/vdb→/skill and /dev/vdc→/etc/skill-ca
    read-only, mounts tmpfs /tmp + /run, starts the loopback↔vsock forwarder,
    emits a ready handshake, then execve's the original workload.

  The workload executable/argv/env travel as a base64url(canonical-CBOR)
  LaunchSpec blob in bootstrapArgv[1] (single channel — raw CBOR cannot ride
  argv since argv is NUL-terminated; not a block artifact, not over the
  control channel); dual size caps (decoded 65536 / argv token 98304)
  enforced before start; NUL bytes rejected in every string; malformed spec
  ⇒ bootstrap exits 127 without execve (fail-closed). The control channel
  is a named virtio-console port ("octopus-control") registered via
  krun_add_virtio_console_multiport + krun_add_console_port_inout (NOT an
  inherited host fd — host fds do not cross the VMM boundary); it carries
  ONLY ready/error frames (NO exit frame — once execve replaces PID 1 no
  bootstrap process remains); workload exit status is the helper subprocess
  exit status caused by krun_start_enter (function only returns on pre-start
  error; otherwise exit()s the helper with the guest exit code).

  Implicit TSI is explicitly disabled (and BLK feature verified) so the sole
  network egress is a vsock-bridged in-process egress proxy (credentials
  never enter the VM). The leaf-package boundary is closed by defining
  VmEnginePort + VmImageBuilderPort in packages/sandbox and injecting both
  via DI; packages/sandbox imports nothing from the native package — not
  even `import type`. probe() is parameterless (verifies TCB artifacts + BLK

  - hypervisor + gate-manifest signature + outer release manifest); the
    selected rootfs is qualified in prepare() via resolveRootfs +
    assertRootfsQualified.

  Two qualification gates (host-file-unreachable, network-canary-unreachable)
  run at CI/release time and bind a (platform × artifact-digest) gate
  manifest — including imageBuilder + qualifiedRootfsDigests[] +
  manifestDigest (self-hash over body excluding the digest field) — signed
  by an outer release manifest (Ed25519, compiled-in public key). Runtime
  probe verifies the manifest+signature; prepare asserts the selected rootfs
  is qualified before claiming `full`. libkrun v1.19.4 is built from pinned
  source (the upstream release ships no binary assets); libkrunfw v5.5.0
  uses the upstream prebuilt tarballs. L3 (7) + L4 (9) escape-matrix tests
  are skipIf-gated on `OCTOPUS_VM_LANE=1` + `probe()` and run on the `vm-lane`
  CI job in `sandbox-security.yml`. Available on macOS Apple Silicon; Linux
  x64 requires a privileged /dev/kvm CI lane or is marked unsupported
  (fail-closed).

- feat(sandbox): VM gate-manifest + outer release-manifest verification — self-hashed gate manifest (manifestDigest over body excluding the field), fail-closed on tampered body / G1 or G2 NO-GO / empty qualifiedRootfsDigests / artifact digest mismatch; Ed25519 outer release-manifest signature verification against compiled-in public key.
- 1442cc7: feat(sandbox): VM gate-manifest + outer release-manifest verification — self-hashed gate manifest (manifestDigest over body excluding the field), fail-closed on tampered body / G1 or G2 NO-GO / empty qualifiedRootfsDigests / artifact digest mismatch; Ed25519 outer release-manifest signature verification against compiled-in public key.
- VM launch-spec encoding: canonical CBOR + base64url with NUL rejection and dual size caps (decoded 65536 / argv 98304).
- 7783966: VM launch-spec encoding: canonical CBOR + base64url with NUL rejection and dual size caps (decoded 65536 / argv 98304).
- feat(sandbox): VM TCB digest verification (helper+libkrun+libkrunfw+image-builder) — strict Zod manifest schema, fail-closed on tamper/size/mode mismatch, symlink substitution, group/world-writable, and unknown schemaVersion.
- e2fc1d9: feat(sandbox): VM TCB digest verification (helper+libkrun+libkrunfw+image-builder) — strict Zod manifest schema, fail-closed on tamper/size/mode mismatch, symlink substitution, group/world-writable, and unknown schemaVersion.
- VM trusted guest env construction: `buildGuestEnv` builds the final `KEY=VALUE[]` env array with untrusted `spec.env` first, then trusted proxy/CA overrides that win on collision (security invariant).
- 4c0ac2c: VM trusted guest env construction: `buildGuestEnv` builds the final `KEY=VALUE[]` env array with untrusted `spec.env` first, then trusted proxy/CA overrides that win on collision (security invariant).
- c0343ed: Add VM backend consumer-side contract types (VmProbeResult, VmWorkloadSpec, VmStartConfig, VmInstance, VerifiedArtifact), port interfaces (VmEnginePort, VmImageBuilderPort), and errors (ExecutablesUnqualifiedError, LaunchSpecTooLargeError, RunSpecError) under packages/sandbox/src/vm/. Leaf-package boundary enforced: vm/ports.ts and vm/types.ts import nothing from @agentoctopus/\*.

### Patch Changes

- e0d70e8: fix(ci): drop unsupported attestation flags + wire runtime image + fixed egress subnet

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
     subnets"). `createEgressNetwork` now derives a per-session `10.b.c.0/24`
     subnet from the network name's session token via FNV-1a (a private range
     outside Docker's default 172.17-172.29 auto-allocation pool, and distinct
     per session so concurrent vitest files don't collide). The test's
     `pickStaticIp` reads the subnet via `network inspect`, so it auto-adapts.

  4. The runtime rootfs producer/verifier rejected ALL symlinks, but the
     exported distroless runtime image contains 377 standard symlinks
     (`etc/mtab -> /proc/mounts`, `libstdc++.so.6 -> libstdc++.so.6.0.30`,
     ~370 `usr/share/zoneinfo/*`, etc.). Strict rejection made it impossible
     to produce a rootfs from a real image — the script had never run against
     one before. Both the producer (`build-runtime-rootfs.mjs`) and verifier
     (`verifyRuntimeArtifact` in `src/os/rootfs.ts`) now record symlinks as
     `kind:'symlink'` + `linkTarget` (mirroring the existing `snapshot.ts`
     `walk()` precedent) and reject any symlink whose target resolves outside
     the rootfs (path-traversal vector). A producer pre-pass strips
     runtime-only entries with no static representation — root-level
     `proc`/`dev`/`sys` (mounted at chroot time by `helper.c`) and any
     escaping symlink (caught by generic escape-check, never by name). The
     ELF closure now resolves DT_NEEDED sonames through symlinks (e.g.
     `libstdc++.so.6`), matching dynamic-loader behavior.

  5. The runtime image ships node at `/usr/local/bin/node` (per the
     `build-security-images.mjs` Dockerfile), but the rootfs verifier's
     `nodePath` enum and the producer's `nodeCandidates` only accepted
     `/usr/bin/node` or `/bin/node` — contradicting `schema.ts` and
     `backend.ts`, which already allow `/usr/local/bin/node`. The symlink
     failure (#4) had masked this since the producer never reached the node
     lookup. Both sites now accept `/usr/local/bin/node`, and the stale
     `linux-lane-setup.ts` comment claiming the image ships node at
     `/usr/bin/node` is corrected.

  6. The symlink escape check (#4) false-positive'd on absolute targets: it
     resolved them against the host root, so a legitimate in-rootfs absolute
     link — the x86_64 ELF interpreter
     `lib64/ld-linux-x86-64.so.2 -> /lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`
     — was stripped, and the closure then failed to find the interpreter.
     A rootfs is chrooted at runtime, so absolute targets are confined to the
     rootfs root. The check now re-anchors absolute targets under the rootfs
     root and rejects only genuine `..` traversal above root. The producer
     pre-pass additionally strips dangling absolute links whose re-anchored
     target is absent from the static rootfs (e.g. `etc/mtab -> /proc/mounts`,
     where `/proc` is mounted at runtime) — those are runtime-only and a
     path-traversal vector if declared. Legitimate absolute links whose target
     exists in the rootfs (the interpreter) are kept.

  7. The `hosted-docker-proxy` lane failed the "uses the exact command argv
     with no image entrypoint mangling" test: `runProbe('argv', { command:
['node', '/skill/probe.js', 'alpha', 'two words'] })` returned
     `result.json.argv === undefined` despite `exitCode === 0`. Root cause:
     commit `dc6eeec` (privileged-Linux lane) flipped the probe's action
     resolution from env-only to `process.argv[2] ?? process.env.PROBE_ACTION`
     so the env-stripped OS lane could pass the action as argv. But the Docker
     `argv` test places a payload (`'alpha'`) at argv[2] AND sets
     `PROBE_ACTION='argv'` — so argv[2] shadowed the action, the `argv`
     branch never fired, no JSON was emitted, and `parseProbeJson` returned
     `{}`. The probe now resolves env-first
     (`process.env.PROBE_ACTION ?? process.argv[2]`): the Docker lane always
     sets `PROBE_ACTION`, so argv is free to hold test payloads; the OS/VM
     lanes strip env (`PROBE_ACTION` is not on their allowlist), so they fall
     through to argv[2] unchanged — a no-op for the env-stripped lanes.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>

- 82c1482: feat(sandbox-vm-native): native VmEngineDeps binding + production constructor wiring (CR-5)

  - Added `koffi`-based `createNativeDeps()` FFI binding in `packages/sandbox-vm-native/src/native-binding.ts`.
  - Implements `pipe()` (Linux `pipe2(O_CLOEXEC)` / Darwin `pipe()+__fcntl(F_SETFD,FD_CLOEXEC)`), `dupFdCloexec()` (`F_DUPFD_CLOEXEC`), and `spawn()` (`posix_spawn` + file actions + Darwin `POSIX_SPAWN_CLOEXEC_DEFAULT`).
  - `spawn()` creates real stdout/stderr pipes with `adddup2` file actions; controlRead/stdin are overridden by the engine with fd-backed streams (Approach A) via `__octopusNeedsEngineOverride` sentinel marker.
  - `waitpid` ECHILD (rc<0) treated as child-already-reaped (resolve, not reject).
  - NUL-byte rejection in argv/envp (koffi silently truncates at NUL).
  - Wires `createVmBackend()` to construct `VmEngineImpl(engineOpts, createNativeDeps())` and `VmImageBuilderImpl(builderBinaryPath)`.
  - Extends `sandbox.vm` schema with optional artifact-path fields defaulting to `prebuilds/<platform>/`.
  - Fail-closed existence check on helperPath/builderBinaryPath in assembly.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>

- 981ed72: feat(core): createVmBackend factory wires VM backend as optional native dep

  Adds createVmBackend + createDefaultSandboxRunnerAsync. Exports VmSandboxBackend from @agentoctopus/sandbox barrel. Native package is optional; missing/incomplete native fails closed to {unavailable}.

- 907f4ea: Make the VM L3/L4 lane fail-closed on a missing/skipped TCB (F2).

  The VM lane tests constructed VmEngineImpl with no arguments, but the
  constructor requires (opts, deps) — probe() read this.deps.platform →
  TypeError → the beforeAll catch swallowed it → every L3/L4 test silently
  skipped → the lane passed with ZERO tests executed, proving nothing about VM
  isolation. Add a shared buildLaneVmEngine() helper that wires real opts
  (prebuilds paths) + createNativeDeps(), and use it in vm-lane.test.ts,
  vm-escape-matrix.test.ts, and vm-lane-setup.ts. The vm-lane CI job now emits a
  JSON report and runs assert-no-skipped-tests.mjs (mirroring the privileged-
  linux lane), so a missing TCB fails the job → security-gate fails, rather
  than silently passing. Cross-produce the rootfs on the Linux release lane
  (build-vm-rootfs.mjs is Linux-only) and download it in the macOS vm-lane,
  which builds its own darwin-arm64 helper + libkrun/libkrunfw in-run.

- c42c0b3: Fix release-manifest signature producer↔verifier mismatch (F3).

  The producer wrote one enveloped `outer-release-manifest.json`
  (`{ manifest, signature, signedBy, signedAt }`) but the verifier read two
  files and verified the signature over the FIRST file's bytes — feeding the
  envelope as `releaseManifestPath` verified the signature over the envelope
  JSON (which includes signature/signedAt), not the inner body, so verification
  always failed. The assembly also set no default paths, so production never
  wired the verifier at all.

  Switch to a detached-signature scheme matching the verifier's contract: the
  signer writes `release-manifest.json` (raw canonical gate-manifest body — the
  exact bytes the signature covers) + `release-manifest.json.sig` (base64
  Ed25519), keeping the enveloped bundle as a human-readable artifact only. The
  assembly defaults both paths to `prebuilds/<platform>/`. Engine `probe()` now
  treats a PRESENT manifest with `no-key` (empty trust root placeholder) as
  fail-closed `signature-invalid` rather than soft `missing` — a present-but-
  unverifiable signature is not a capability probe, so the bootstrap fails loud
  on any real release until `RELEASE_PUBLIC_KEY_BASE64` is committed. Absent
  manifest files still soft-fall to `missing` (dev box).

- 527f236: Fix output cap memory bound (F5) and IPv6 loopback rejection (F6).

  F5: `collectBounded*Result` in the vm/docker/os backends pushed each chunk
  BEFORE checking the combined stdout+stderr cap and kept pushing after overflow
  was set, so a flooding process could push the captured buffer far past
  `outputMaxBytes` before the kill landed. The cap is now checked first, the
  offending chunk is trimmed to the exact remaining budget, and further chunks
  are dropped once overflow fires — the captured buffer never exceeds the cap.

  F6: Node's `URL.hostname` preserves IPv6 brackets
  (`new URL('http://[::1]:8').hostname === "[::1]"`), so the VM backend's loopback
  set lookup rejected the explicitly-allowed `::1` egress-proxy target, and
  `normalizeHost` left brackets in place for every policy-engine caller. A new
  `stripIpv6Brackets` helper strips them before the loopback check and at the top
  of `normalizeHost`, so `::1` is a valid loopback target everywhere.

- 7208e49: fix(sandbox): surface the OS helper's early stderr when cgroup attach hits ESRCH

  When the OS helper dies before it can self-stop (a phase-1/phase-2 `die()` —
  netns, mount, chroot, or launch-spec parse), `spawn()`'s cgroup `attach()` fails
  with `ESRCH: no such process`, which on its own is silent about WHY the helper
  exited. The helper always writes its diagnostic to fd 2 before `_exit(127)`, but
  the backend only wired up the stderr pipe after attach succeeded — so the reason
  was lost and the privileged lane reported a bare ESRCH.

  `spawn()` now buffers the helper's stderr from the moment of spawn (bounded, and
  defensively against non-EventEmitter test doubles), and on attach failure
  appends the helper's own diagnostic to the thrown error. The buffered bytes are
  kept out of the skill's stderr stream once the pipes are wired after SIGCONT.

- 5e85d3b: fix(sandbox): create the OS-backend workDir before assembleRootfs mkdtemps into it

  `OsSandboxBackend` assigned `this.workDir` in the constructor but only created
  it later (the launch-spec `mkdir`). `assembleRootfs()` then ran
  `mkdtemp(join(workDir, 'rootfs-'))` against a parent that did not exist yet, so
  every privileged-linux lane test died with
  `ENOENT: no such file or directory, mkdtemp '.../oct-os-backend-*/rootfs-*'`.

  Create the workDir (`mkdir recursive, 0700`) immediately before the assemble
  call. The later launch-spec `mkdir` is idempotent (recursive) so this is a pure
  ordering fix — no behavior change beyond removing the ENOENT.

- 817e0c6: fix(sandbox): setns into the named netns BEFORE the CLONE_NEWUSER pivot in os-helper

  `os-helper` phase 1 called `unshare(CLONE_NEWUSER|...)` and only THEN
  `setns(netnsFd, CLONE_NEWNET)`. `setns()` into a pre-existing network namespace
  requires `CAP_SYS_ADMIN` in the CURRENT (root) user namespace — which the
  `CLONE_NEWUSER` unshare immediately drops (the process becomes root only of the
  fresh userns, which does not own the named netns). The helper therefore died with
  `setns(netnsFd, CLONE_NEWNET): Operation not permitted`, the spawn-time cgroup
  attach then hit `ESRCH`, and every privileged-linux spawn test failed.

  Join the named netns before the user-namespace pivot. `setns` changes only the
  network namespace, so the subsequent `unshare(CLONE_NEWUSER|CLONE_NEWNS|CLONE_NEWPID|...)`
  creates the mount/pid/ipc/uts/user namespaces fresh while leaving the just-joined
  net namespace in place — the sandbox keeps the named netns through the pivot.

- d4b64f2: fix(sandbox): capture real uid/gid before unshare in os-helper namespace pivot

  The trusted `os-helper` builds the sandbox's user-namespace uid_map/gid_map as
  `"0 <real-id> 1"` (in-ns uid 0 → the real host id) so root-owned files in the
  verified runtime root stay accessible after the pivot. But both the launch path
  (`phase1_outside_chroot`) and the privileged-capability probe
  (`probe_namespaces`) called `getuid()`/`getgid()` AFTER
  `unshare(CLONE_NEWUSER|...)`. Inside the fresh user namespace, with no uid_map
  written yet, `getuid()` returns the kernel overflow id (65534), so the helper
  wrote `"0 65534 1"` — an invalid mapping the kernel rejects with EPERM, failing
  the whole pivot at the `uid_map` write.

  The bug was latent: the privileged Linux lane requires a self-hosted
  `sandbox-privileged` runner that did not exist, so `os-helper` had never
  actually executed on a real host. With a runner provisioned, the lane's
  `security:probe-linux -- --require` step failed with
  `os-helper: /proc/self/uid_map: Operation not permitted` (exit 127).

  Fix: capture `ruid`/`rgid` before the `unshare` call in both functions, so the
  map targets the real host id (`"0 0 1"` for a root-run helper). Verified by
  compiling the helper and running `--probe-namespaces` on a privileged Ubuntu
  host: exit 127 before, exit 0 after.

- 3f54a3c: fix(sandbox): retry the cgroup attach read-back on a bounded budget

  `OsSandboxBackend.spawn` attaches the SIGSTOPped helper child to its session
  cgroup via `attach()` before SIGCONT — the security gate that confines the child
  before execve. Node's `spawn()` returns the pid the instant fork completes, but
  the kernel cgroup membership of a freshly spawned, self-stopped child can take a
  moment to settle on a busy CI host; the single write+immediate read-back could
  transiently miss the pid and abort the run with "cgroup.procs read-back does not
  contain pid … — refusing to continue unconfined" (10 privileged-linux tests).

  `attach()` now retries the write+read-back on a short bounded budget (10 × 25ms)
  and stays FAIL-CLOSED: if the pid never lands in the leaf (helper genuinely
  exited or was refused), it still throws and never SIGCONTs an unconfined child.

- security-cleanup-linux now also kills leaked netns-mode egress-proxy node processes (`egress-proxy-server.mjs`) before tearing down their netns/nft/cgroups. On a persistent privileged runner, a session interrupted mid-run leaks the proxy process (reparented to PID 1); each leak pins its `octn-*` netns open and commits tens of MB of V8 memory, so dozens of leaks push the runner's Committed_AS past CommitLimit until Node aborts (SIGABRT, exit 134) and nested forks EAGAIN. Killing the proxies first lets the netns/cgroup teardown actually succeed and reclaims the leaked memory. Detection reads `/proc/*/cmdline` for the proxy entrypoint (never a bare `node`), SIGTERM then SIGKILL for survivors.
- 689d833: security-cleanup-linux now also kills leaked netns-mode egress-proxy node processes (`egress-proxy-server.mjs`) before tearing down their netns/nft/cgroups. On a persistent privileged runner, a session interrupted mid-run leaks the proxy process (reparented to PID 1); each leak pins its `octn-*` netns open and commits tens of MB of V8 memory, so dozens of leaks push the runner's Committed_AS past CommitLimit until Node aborts (SIGABRT, exit 134) and nested forks EAGAIN. Killing the proxies first lets the netns/cgroup teardown actually succeed and reclaims the leaked memory. Detection reads `/proc/*/cmdline` for the proxy entrypoint (never a bare `node`), SIGTERM then SIGKILL for survivors.
- eca3a3e: linux-topology lane: make the proxy-traversal test hermetic via a credential grant, and fix the teardown test deriving the wrong host veth.

  - **Proxy-traversal test (hermetic):** the prior attempt fetched a public host (`example.com`), but the self-hosted runner's public egress is restricted, so the proxy could not reach it (non-2xx). The test now does a fully hermetic round-trip: a host-side loopback upstream on an ephemeral port, admitted by a **credential grant** (the only way the policy admits a non-default port — Rule 3) plus an exact host grant of the private literal (Rule 4 → `allowPrivateLiteral`, lifting the loopback SSRF block for this explicitly-granted target). The fixture's `afterTopology` hook now returns `{ hosts?, credentials? }` and the fixture wires the credential grant into `config.grants` and its key into `request.credentials` (resolvePolicy intersects the two). No secret value is wired, so the proxy authorizes + forwards without injecting an auth header (`egress-proxy.ts` injects only `if (secret)`). Because the skill netns has no off-box route but the /32 peer route to the proxy, a 2xx proves proxy-only egress — with no external dependency.
  - **Teardown test (`deriveNetnsFacts`):** the fixture derived `hostVeth` by grepping the _global_ `ip link` list for the first `oh*` interface. On a persistent runner that list accumulates STALE `oh*` veths leaked by pre-reaper runs, so the first match was always the same leftover — not this session's (correctly-cleaned) interface — and the teardown assertion failed against a name the session never owned. The nft table (`oct_<salt>`) and host veth (`oh<salt>`) share the same per-session salt (`netns.ts` `deriveNames`), so `hostVeth` is now derived from the netns-scoped table name (`oh` + salt), immune to stale leftovers. The test also now asserts `netnsCleanupErrors` is empty (teardown recorded no non-benign errors).

- 119a837: tests(security): fix linux-topology assertions to match the host-side proxy + shared session cgroup. Four test-side corrections (no sandbox behavior change) for failures newly exposed now that the os-helper reaches `execve` and the topology suite runs for the first time:

  - **Proxy listener checks (`/32 route`, `EADDRINUSE`):** the egress proxy binds HOST-SIDE — `setupNetns` assigns `proxyIp` to the host-side veth (`hostIf`, which stays on the host; only `skillIf` enters the skill netns) and `egress-proxy-server` listens on that host address (os-backend: "the proxy binds host-side over the carrier"; the HTTPS test itself notes "the proxy runs on the HOST"). Two tests wrongly ran `ss -ltnH` INSIDE the skill netns, where the host-side listener is not visible, so they always counted 0. Added `hostSsListenCount()` (runs `ss` on the host) and switched both assertions to it. The EADDRINUSE second-bind was already host-side and correct.
  - **CA read-only behavioral probe:** previously called `backend.run()` on the SAME sandbox that holds the persistent `block` probe (needed for the nsenter PID). A one-shot `run()` then failed its post-exit "session cgroup is empty" containment check against that persistent process. The behavioral probe now runs via `runLinuxProbe()` on a fresh sandbox — every sandbox mounts its session CA read-only at the same contract path, so the read-only guarantee is still proven, without the shared-cgroup conflict.
  - **HTTPS-through-proxy:** this test drives its own one-shot `backend.run()` through the proxy and does not need the persistent `block` probe, so `startTopologySandbox` now takes a `spawnBlock` flag (default true, existing tests unchanged) and this test passes `false`, leaving the session cgroup empty for `run()`'s containment check.

- linux-topology lane: fix the proxy-traversal test to match the egress proxy's policy model, and surface netns teardown errors for the teardown-leak case.

  - **Proxy-traversal test:** previously drove a loopback upstream on an ephemeral `listen(0)` port and granted only the host `127.0.0.1`. The egress proxy policy grants HOSTS at their default port (Rule 3); a non-default port requires an explicit target/credential grant the lane does not wire, and a private/loopback literal is additionally SSRF-protected. The request was therefore denied by policy (403) — correct proxy behavior, not a proxy bug — so the probe exited non-zero. The test now fetches a granted PUBLIC host on its default port (`http://example.com/`, host granted) through the host-side proxy; because the skill's netns has no off-box route except the /32 peer route to the proxy, a 2xx proves egress is proxy-only (the companion `direct-internet` lane test proves the skill cannot reach it directly).
  - **`OsSandboxBackend.netnsCleanupErrors` (concrete-class getter):** captures the non-benign errors recorded by the most recent netns teardown (`netns.ts` `cleanupErrors` — EBUSY/EPERM/still-in-use; already-absent/ENOENT is treated as success and not recorded). Mirrors the existing concrete-only `skillCgroupPath` getter. The teardown lane test logs it alongside the live host-side veth state to diagnose a leaked host veth/netns.

- 773f76c: linux-topology lane: fix the proxy-traversal test to match the egress proxy's policy model, and surface netns teardown errors for the teardown-leak case.

  - **Proxy-traversal test:** previously drove a loopback upstream on an ephemeral `listen(0)` port and granted only the host `127.0.0.1`. The egress proxy policy grants HOSTS at their default port (Rule 3); a non-default port requires an explicit target/credential grant the lane does not wire, and a private/loopback literal is additionally SSRF-protected. The request was therefore denied by policy (403) — correct proxy behavior, not a proxy bug — so the probe exited non-zero. The test now fetches a granted PUBLIC host on its default port (`http://example.com/`, host granted) through the host-side proxy; because the skill's netns has no off-box route except the /32 peer route to the proxy, a 2xx proves egress is proxy-only (the companion `direct-internet` lane test proves the skill cannot reach it directly).
  - **`OsSandboxBackend.netnsCleanupErrors` (concrete-class getter):** captures the non-benign errors recorded by the most recent netns teardown (`netns.ts` `cleanupErrors` — EBUSY/EPERM/still-in-use; already-absent/ENOENT is treated as success and not recorded). Mirrors the existing concrete-only `skillCgroupPath` getter. The teardown lane test logs it alongside the live host-side veth state to diagnose a leaked host veth/netns.

- d0db1d7: linux-topology lane: fix two test-harness teardown bugs that the prior hermetic/veth fixes exposed.

  - **Proxy-traversal test hang (180s timeout):** the fixture's loopback upstream
    was closed in `finally` with `server.close()`, which waits for EVERY accepted
    connection to end and has NO timeout. The egress proxy's connection to the
    upstream can linger (half-closed) after the round-trip, so `close()` blocked
    forever and the test ran to its full 180s timeout — masking the credential
    round-trip. The fixture now tracks every accepted connection and destroys
    them explicitly before `close()` (with a 2s `close()` ceiling as
    belt-and-suspenders). This is version-independent: `server.closeAllConnections()`
    is not available on the runner's Node, so an explicit tracked-socket destroy
    is used instead. This was the ONLY unbounded operation in the test path
    (setup, `backend.run()`, `cgroup.waitEmpty`, and `sandbox.cleanup()` are all
    deadline-bounded; the companion teardown test proves `cleanup()` does not
    hang).
  - **Teardown test re-bind assertion (EADDRNOTAVAIL):** the final step re-bound
    `proxyIp:proxyPort` to prove the proxy listener closed. That is incompatible
    with correct teardown: `proxyIp` lives on the host veth, which teardown
    deletes (and the test asserts is gone), so the address no longer exists and a
    bind fails EADDRNOTAVAIL rather than reading the EADDRINUSE-vs-closed signal.
    Replaced with `hostSsListenCount(proxyIp, proxyPort) === 0` — the host `ss`
    table shows no listener on the proxy address (the kernel destroyed the socket
    bound to the deleted veth), which is consistent with full teardown.

- os-helper: bind-mount host device nodes instead of mknod() for the private /dev. The privileged-CI runner's kernel hardening denies mknod() inside an unprivileged user namespace outright (EPERM) even when the caller is root-in-userns with CAP_MKNOD, the target is a fresh tmpfs mounted WITHOUT MS_NODEV, and no device cgroup is attached — killing the helper before the cgroup attach (surfaced as ESRCH). Bind-mounting the host's EXISTING /dev/{null,zero,full,random,urandom} nodes onto placeholder files in the private tmpfs needs no CAP_MKNOD and is not subject to that restriction (the same technique bubblewrap uses). The sandbox still exposes exactly those five devices, read-write; the private /dev tmpfs superblock still carries nosuid.
- 07980ee: os-helper: bind-mount host device nodes instead of mknod() for the private /dev. The privileged-CI runner's kernel hardening denies mknod() inside an unprivileged user namespace outright (EPERM) even when the caller is root-in-userns with CAP_MKNOD, the target is a fresh tmpfs mounted WITHOUT MS_NODEV, and no device cgroup is attached — killing the helper before the cgroup attach (surfaced as ESRCH). Bind-mounting the host's EXISTING /dev/{null,zero,full,random,urandom} nodes onto placeholder files in the private tmpfs needs no CAP_MKNOD and is not subject to that restriction (the same technique bubblewrap uses). The sandbox still exposes exactly those five devices, read-write; the private /dev tmpfs superblock still carries nosuid.
- os-helper: drop the untrusted process to the MAPPED root id (in-ns 0 → host ruid), not uid/gid 65534 — and keep the single-line uid/gid self-map. Root cause of the privileged-lane credential-drop cascade:

  After `unshare(CLONE_NEWUSER)` the helper's credentials live in the NEW (child) user namespace, and the kernel's `cap_capable()` level check refuses to look up `CAP_SETUID`/`CAP_SETGID` in an ANCESTOR namespace from a descendant (`ns->level <= cred->user_ns->level` → EPERM). So a MULTI-line uid_map/gid_map (which skips the unprivileged single-extent self-map exemption and falls to the privileged `ns_capable(ns->parent,…)` path) EPERMs no matter how much privilege the helper holds — the helper cannot write its own two-line map from inside the child namespace. Only the single-extent identity self-map `"0 rid 1"` is writable (the kernel's `nr_extents==1` exemption). Consequently the untrusted target 65534 is NOT mappable, and `setuid/setgid(65534)` would EINVAL.

  Resolution: keep the single-line self-map (unmappable 65534 is never written) and have phase 3 drop to the MAPPED root id 0. This is still full isolation: in-ns "root" maps to the UNPRIVILEGED host ruid, and the process remains confined by `NO_NEW_PRIVS` + chroot + the named netns + cgroup — "root" here has no host privilege. Mapping 65534 would require a privileged PARENT-namespace writer for `/proc/<pid>/uid_map`, which this self-contained helper does not have.

  Also dropped the phase-3 `setgroups(0, NULL)` call: phase-1's mandatory `setgroups` "deny" (required for the gid self-map) irreversibly disables `setgroups(2)` in the namespace, and the call is a no-op anyway (the runner runs with no supplementary groups — `Groups:` empty). This reverts the two earlier incorrect attempts (a root-only "deny" skip that broke gid_map, and a two-line overflow map that EPERMs).

- 0f6ed4d: os-helper: drop the untrusted process to the MAPPED root id (in-ns 0 → host ruid), not uid/gid 65534 — and keep the single-line uid/gid self-map. Root cause of the privileged-lane credential-drop cascade:

  After `unshare(CLONE_NEWUSER)` the helper's credentials live in the NEW (child) user namespace, and the kernel's `cap_capable()` level check refuses to look up `CAP_SETUID`/`CAP_SETGID` in an ANCESTOR namespace from a descendant (`ns->level <= cred->user_ns->level` → EPERM). So a MULTI-line uid_map/gid_map (which skips the unprivileged single-extent self-map exemption and falls to the privileged `ns_capable(ns->parent,…)` path) EPERMs no matter how much privilege the helper holds — the helper cannot write its own two-line map from inside the child namespace. Only the single-extent identity self-map `"0 rid 1"` is writable (the kernel's `nr_extents==1` exemption). Consequently the untrusted target 65534 is NOT mappable, and `setuid/setgid(65534)` would EINVAL.

  Resolution: keep the single-line self-map (unmappable 65534 is never written) and have phase 3 drop to the MAPPED root id 0. This is still full isolation: in-ns "root" maps to the UNPRIVILEGED host ruid, and the process remains confined by `NO_NEW_PRIVS` + chroot + the named netns + cgroup — "root" here has no host privilege. Mapping 65534 would require a privileged PARENT-namespace writer for `/proc/<pid>/uid_map`, which this self-contained helper does not have.

  Also dropped the phase-3 `setgroups(0, NULL)` call: phase-1's mandatory `setgroups` "deny" (required for the gid self-map) irreversibly disables `setgroups(2)` in the namespace, and the call is a no-op anyway (the runner runs with no supplementary groups — `Groups:` empty). This reverts the two earlier incorrect attempts (a root-only "deny" skip that broke gid_map, and a two-line overflow map that EPERMs).

- 93d29b7: os-helper: read the per-mount vfs options (mountinfo field 6), not the superblock options (field 10), when asserting a mount is read-only. The read-only flag is a per-mount flag (MNT_READONLY) set by the bind's ro-remount and reported in field 6, BEFORE the "-" separator. Field 10 reflects the underlying superblock (the rw ext4 the runtime root was bound FROM) and stays "rw" for a read-only bind — so the previous field-10 check always reported a correctly ro-remounted bind as writable and refused to exec ("mount / is not read-only"). The guard now validates the flag that the remount actually sets.
- os-helper: raise `--stop-before-exec` SIGSTOP in the PARENT (before phase-1 setup), not the child. Root cause of the privileged-lane pids-ceiling + timeout regression:

  The backend's `cgroup.attach(pid)` attaches the SPAWNED pid — the helper parent that `os-backend.ts` gets from `spawn()`. But the helper previously raised SIGSTOP in the CHILD (`phase3_enter_root`), a pid the backend never sees (the child is created inside the helper after `unshare(CLONE_NEWPID)` + `fork()`). In cgroup v2, writing a pid to `cgroup.procs` moves that process but NOT its existing children — only NEW forks inherit the parent's cgroup. Because the child was forked BEFORE the parent was attached, the untrusted node process (and every grandchild it forked) stayed OUTSIDE the session cgroup. So `pids.max=64` never bounded the fork-bomb (the probe spawned >63 children) and `cgroup.kill` never reached the grandchildren (the widespread test timeouts waiting for output/exit/reaping).

  Fix: raise SIGSTOP in the PARENT in `main()` before phase 1. The backend attaches the spawned pid (unchanged code — exactly the pid `attach()`'s read-back/retry machinery was built for), verifies membership, then SIGCONTs. The ENTIRE untrusted setup — netns enter, unshare, mounts, chroot, fork, execve — then runs inside the session cgroup, and the PID-namespace-init child inherits the cgroup at `fork()` from its first instruction. This is strictly stronger than the old child-stop design (the child is confined from instruction 0 rather than stopping mid-setup outside the cgroup). The uid change (mapped-root) merely EXPOSED this latent bug by letting the helper reach `execve` for the first time; reverting it would only re-mask the bug. Comments updated in helper.c, cgroup.ts, run-spec.ts, os-backend.ts.

- e9f39ae: os-helper: raise `--stop-before-exec` SIGSTOP in the PARENT (before phase-1 setup), not the child. Root cause of the privileged-lane pids-ceiling + timeout regression:

  The backend's `cgroup.attach(pid)` attaches the SPAWNED pid — the helper parent that `os-backend.ts` gets from `spawn()`. But the helper previously raised SIGSTOP in the CHILD (`phase3_enter_root`), a pid the backend never sees (the child is created inside the helper after `unshare(CLONE_NEWPID)` + `fork()`). In cgroup v2, writing a pid to `cgroup.procs` moves that process but NOT its existing children — only NEW forks inherit the parent's cgroup. Because the child was forked BEFORE the parent was attached, the untrusted node process (and every grandchild it forked) stayed OUTSIDE the session cgroup. So `pids.max=64` never bounded the fork-bomb (the probe spawned >63 children) and `cgroup.kill` never reached the grandchildren (the widespread test timeouts waiting for output/exit/reaping).

  Fix: raise SIGSTOP in the PARENT in `main()` before phase 1. The backend attaches the spawned pid (unchanged code — exactly the pid `attach()`'s read-back/retry machinery was built for), verifies membership, then SIGCONTs. The ENTIRE untrusted setup — netns enter, unshare, mounts, chroot, fork, execve — then runs inside the session cgroup, and the PID-namespace-init child inherits the cgroup at `fork()` from its first instruction. This is strictly stronger than the old child-stop design (the child is confined from instruction 0 rather than stopping mid-setup outside the cgroup). The uid change (mapped-root) merely EXPOSED this latent bug by letting the helper reach `execve` for the first time; reverting it would only re-mask the bug. Comments updated in helper.c, cgroup.ts, run-spec.ts, os-backend.ts.

- 1c4e384: os-helper: add a PID-1 init/reaper so the session cgroup drains after the workload exits; fix the pids-flood probe's fork measurement. Two coupled fixes for the privileged-lane cgroup-containment failures (4× "cgroup not empty after child close" + the pids.max fork-bomb):

  **Reaper (helper.c).** The helper child is PID 1 in the new PID namespace, and PID 1 is the mandatory reaper for every descendant — including orphaned grandchildren re-parented to it. The untrusted workload (node) does NOT reap its detached/unref'd children, so when they exit they become ZOMBIES. A zombie is still a task in the session cgroup, so `cgroup.events populated` stays 1 and the backend's post-run `waitEmpty()` fails. The kernel SIGKILLs _orphans_ when PID 1 dies, but node's _own_ already-exited children are zombies only a LIVING process inside the namespace can reap — and the backend (parent ns) cannot cross that boundary. So the child no longer execs the workload directly: it stays as a minimal init/reaper (the standard tini/runc pattern), forks a grandchild that runs phase 3 + execve, and reaps all descendants in a `waitpid(-1, WNOHANG)` loop until the worker exits, then propagates its exit code. This drains the cgroup promptly so teardown's netns/veth/nft cleanup also succeeds.

  **Probe measurement (lane-probe.ts).** The pids-flood action counted `spawn()` calls in a try/catch, but `spawn()` does NOT throw synchronously when the kernel refuses fork() past pids.max — fork-EAGAIN is delivered asynchronously as an `'error'` event (verified empirically under a pids-limit-64 container: 200 spawn() returns, 187 async 'error' events, zero sync throws). The try/catch therefore counted spawn-attempts (always 200) and could never observe the ceiling, failing the test regardless of enforcement. The probe now counts the `'spawn'` event (child truly started) vs the `'error'` event (fork refused) and settles one tick before emitting, so `spawned <= 63` genuinely measures enforcement. The test comment is updated to match.

- os-helper: stop passing mount flags the kernel ignores on remount. Some distro kernels (the privileged-CI runner) carry an out-of-tree mount-flag validator that rejects MS_REMOUNT|MS_BIND combined with MS_REC (EPERM 0x5021) or with MS_NOSUID|MS_NODEV (EPERM 0x1021), killing the helper before the cgroup attach (surfaced as ESRCH). Two changes, both behavior-preserving on mainline: (1) drop the no-op MS_REC from the read-only remounts (remount_ro never recurses); (2) move MS_NOSUID|MS_NODEV off the remount and onto the initial bind, where the kernel actually honors them — a remount of an already-read-only bind ignores per-mount flag changes. The runtime root and host binds stay read-only and noexec-on-skill; no submounts exist beneath the root at remount time (the rootfs /proc is mounted after chroot).
- 575141f: os-helper: stop passing mount flags the kernel ignores on remount. Some distro kernels (the privileged-CI runner) carry an out-of-tree mount-flag validator that rejects MS_REMOUNT|MS_BIND combined with MS_REC (EPERM 0x5021) or with MS_NOSUID|MS_NODEV (EPERM 0x1021), killing the helper before the cgroup attach (surfaced as ESRCH). Two changes, both behavior-preserving on mainline: (1) drop the no-op MS_REC from the read-only remounts (remount_ro never recurses); (2) move MS_NOSUID|MS_NODEV off the remount and onto the initial bind, where the kernel actually honors them — a remount of an already-read-only bind ignores per-mount flag changes. The runtime root and host binds stay read-only and noexec-on-skill; no submounts exist beneath the root at remount time (the rootfs /proc is mounted after chroot).
- 94f4ca6: tests(security): resolve the privileged-lane node executable path from a single `LANE_NODE` constant (`/usr/local/bin/node`) instead of hardcoding `/usr/bin/node`. The `linux-node22` runtime rootfs ships node at `/usr/local/bin/node` (per `runtimeProfile.osRuntime.nodePath`); several privileged-lane probes hardcoded `/usr/bin/node`, which does not exist in the rootfs and made the helper's `execve` fail ENOENT once the credential-drop fixes (mapped-root) finally let the helper reach `exec`. This was a latent test bug, masked while the helper died earlier at the credential drop. A shared constant keeps the probe default and the explicit `command:` arrays in `linux-lane.test.ts` / `linux-topology.test.ts` consistent with the runtime manifest.
- 4cd6484: privileged-linux lane: absorb environmental flakiness with a scoped `retry: 2`.

  The linux-lane + linux-topology tests build a full sandbox each (rootfs extract

  - netns + cgroup + proxy + `os-helper` fork/exec). On the resource-constrained
    self-hosted runner (~930MB RAM, high baseline `Committed_AS`) the helper's
    fork/exec occasionally stalls past a per-op timeout under memory/IO pressure, so
    a one-shot probe returns empty/exit-137 — a HARNESS timeout, never a violated
    property (netns isolation, read-only CA mount, proxy-only egress, and full
    teardown are deterministic given the code). This surfaced as a _different_ test
    timing out on each run (proxy-traversal exit-4 one run, ca-ro-probe empty-JSON
    the next) while a diagnostic run passed all 18 — the signature of contention,
    not a code defect.

  A new `packages/sandbox/vitest.security-lane.config.ts` (its `include` selects
  exactly these two files) enables `retry: 2` for this lane only via
  `--config` in `sandbox-security.yml`. retry re-rolls the environmental timing
  dice; a genuine security violation fails the assertion on EVERY attempt and
  still trips the `assert-no-skipped-tests.mjs` gate (empirically validated: a
  test that fails twice then passes reports final status `passed`, while a test
  that genuinely fails stays `failed` after exhausting retries and is flagged).
  The broad `pnpm test` unit suite is untouched — a flaky unit test masking a real
  bug would be wrong, so retry is confined to the privileged lane.

- Fix a deterministic `produce-linux-artifacts` self-check failure that blocked the vm-lane from ever running.

  **Root cause.** `verifyRuntimeArtifact` (throwaway/scratch path) and `assembleRootfs` cleanup removed the extracted runtime tree with `rm(root, { recursive: true, force: true })`. The runtime rootfs ships read-only entries (e.g. `opt/octopus-boot/undici/LICENSE`), and Node's `force: true` swallows `ENOENT` but **not `EACCES`** — `rmdir`/`unlink` require write+execute on the _parent_ directory, so a read-only directory anywhere in the extracted tree made the cleanup abort with `EACCES: permission denied, unlink '…/undici/LICENSE'`. Worse, because the cleanup runs in a `finally`, that `EACCES` masked the real verification result. Observed as a deterministic failure of the Sandbox Security `produce-linux-artifacts` self-check on the Linux runner (two consecutive runs), which gated off `vm-lane` entirely.

  **Fix.** New `removeExtractedTree()` helper: a best-effort pass chmods the tree user-writable (dirs `0o700`, files `0o600`, symlinks skipped so chmod never follows them) before the authoritative `rm`. Failures in the chmod pass are ignored — the tree may already be partly gone. Wired into both cleanup sites. The helper is exported (documented as not-public-API) so the regression test can drive it directly.

  **Test.** Adds a regression test that builds a tree with a read-only directory (`0o555`) + read-only file (`0o444`) — the exact CI EACCES signature — and asserts `removeExtractedTree` removes it fully. Verified to fail with `EACCES … unlink …/undici/LICENSE` on the pre-fix plain-`rm` cleanup and pass with the chmod pass. (It targets the helper directly rather than the full verify path because the extracted-tree allowlist walk correctly rejects a read-only _directory_ in the manifest — extra mode bits vs the extractor's `0o755` — so the EACCES can't be reached end-to-end through `verifyRuntimeArtifact`.)

- 521e64d: Fix a deterministic `produce-linux-artifacts` self-check failure that blocked the vm-lane from ever running.

  **Root cause.** `verifyRuntimeArtifact` (throwaway/scratch path) and `assembleRootfs` cleanup removed the extracted runtime tree with `rm(root, { recursive: true, force: true })`. The runtime rootfs ships read-only entries (e.g. `opt/octopus-boot/undici/LICENSE`), and Node's `force: true` swallows `ENOENT` but **not `EACCES`** — `rmdir`/`unlink` require write+execute on the _parent_ directory, so a read-only directory anywhere in the extracted tree made the cleanup abort with `EACCES: permission denied, unlink '…/undici/LICENSE'`. Worse, because the cleanup runs in a `finally`, that `EACCES` masked the real verification result. Observed as a deterministic failure of the Sandbox Security `produce-linux-artifacts` self-check on the Linux runner (two consecutive runs), which gated off `vm-lane` entirely.

  **Fix.** New `removeExtractedTree()` helper: a best-effort pass chmods the tree user-writable (dirs `0o700`, files `0o600`, symlinks skipped so chmod never follows them) before the authoritative `rm`. Failures in the chmod pass are ignored — the tree may already be partly gone. Wired into both cleanup sites. The helper is exported (documented as not-public-API) so the regression test can drive it directly.

  **Test.** Adds a regression test that builds a tree with a read-only directory (`0o555`) + read-only file (`0o444`) — the exact CI EACCES signature — and asserts `removeExtractedTree` removes it fully. Verified to fail with `EACCES … unlink …/undici/LICENSE` on the pre-fix plain-`rm` cleanup and pass with the chmod pass. (It targets the helper directly rather than the full verify path because the extracted-tree allowlist walk correctly rejects a read-only _directory_ in the manifest — extra mode bits vs the extractor's `0o755` — so the EACCES can't be reached end-to-end through `verifyRuntimeArtifact`.)

- Fix two Docker-backend defects surfaced by the Plan 6 Docker security lane:

  - Mount the immutable snapshot and session CA with `--mount type=bind` instead of `-v`. The content-addressed snapshot root contains a colon (`<store>/sha256:<hex>`), which `-v host:guest:ro` parses as a field separator and rejects with "too many colons", so no runtime container could start.
  - Wait for the freshly `docker run`-ed egress-proxy container to reach the running state before `docker network connect`. `docker run` returns before the daemon registers the container, so an immediate connect raced the daemon and failed with "No such container", making proxy launch fail on fast hosts.

- 1da822a: Fix two Docker-backend defects surfaced by the Plan 6 Docker security lane:

  - Mount the immutable snapshot and session CA with `--mount type=bind` instead of `-v`. The content-addressed snapshot root contains a colon (`<store>/sha256:<hex>`), which `-v host:guest:ro` parses as a field separator and rejects with "too many colons", so no runtime container could start.
  - Wait for the freshly `docker run`-ed egress-proxy container to reach the running state before `docker network connect`. `docker run` returns before the daemon registers the container, so an immediate connect raced the daemon and failed with "No such container", making proxy launch fail on fast hosts.

- probe before rank in selectBackend and align proxy bundle manifest shape
- 79e7d44: probe before rank in selectBackend and align proxy bundle manifest shape
- Backend selection now probes eligible candidates before ranking, so the Linux OS backend remains selectable under auto/full once it proves full isolation, and adds a guard so a restricted OS backend can never be chosen implicitly. This change adds no macOS execution capability; it only tightens selection semantics.
- be42fa1: Backend selection now probes eligible candidates before ranking, so the Linux OS backend remains selectable under auto/full once it proves full isolation, and adds a guard so a restricted OS backend can never be chosen implicitly. This change adds no macOS execution capability; it only tightens selection semantics.
- Tighten CI sandbox test gates + fix a cross-platform fixture bug:

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

- 0c5eea9: Tighten CI sandbox test gates + fix a cross-platform fixture bug:

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

- 146ef8f: VM backend cleanup + bootstrap verification (ME-2/LO-3):

  - `cleanup()` now removes the backend-owned `workDir` (sealed `skill.img` + `ca.img` block images) as a SOFT teardown step, mirroring `OsSandboxBackend`. A workDir-rm failure is a soft diagnostic reason, never promoted to a `ContainmentCleanupError`.
  - The guest bootstrap PID 1 (`/usr/libexec/octopus-vm-init`, exec'd by the helper at `spawn()`) is now verified fail-closed in `prepare()` via a second `assertExecutablesQualified` call with a synthesized single-entry map + matching bins, preserving the set-equality contract and reusing the full rootfs stat-walk.

- a525160: Implement the per-session vsock host bridge and trustedEnv plumbing.

  - Adds `VsockBridge` to `packages/sandbox/src/vm/vsock-bridge.ts`: a per-session unix-domain socket listener under the 0700 workDir that forwards guest vsock connections to the in-process egress proxy's loopback address.
  - Wires the bridge into `VmSandboxBackend` so that `prepare()` assigns a deterministic non-zero `vsockPort` and absolute `vsockHostSocket`, and `spawn()` passes them via `trustedEnv` so the guest bootstrap can read `OCTOPUS_VSOCK_PORT`/`OCTOPUS_VSOCK_HOST_SOCKET` through `krun_set_exec`.
  - `VmSandboxBackend.cleanup()` stops the bridge as a soft teardown step.
  - Adds unit tests for `VsockBridge` (unix-socket forwarding with a stub proxy) and `VmSandboxBackend` (prepare assigns vsock values, spawn passes `trustedEnv`).

- 44297c0: Fail-closed VM release-signature verification and compiled-in trust root.

  - `RELEASE_PUBLIC_KEY_BASE64` is now a placeholder constant in `packages/sandbox/src/vm/release-key.ts`; the real Ed25519 public key must be committed before the first production release that exercises VM release signing.
  - The test seam `OCTOPUS_VM_RELEASE_KEY_TEST` is renamed/exposed as `RELEASE_PUBLIC_KEY_TEST_SEAM` and is explicitly NOT the production source.
  - `verifyOuterReleaseManifest` returns a discriminated result (`no-key` | `bad-signature` | `ok`) so callers can distinguish an unsigned dev build from an invalid production signature.
  - `VmEngineImpl.probe()` now fails closed (`available: false`, `releaseManifest: 'signature-invalid'`) when both manifest and signature files are present but the signature is invalid; absent files still probe as `missing` with `available: true`.

- 1cf3c5f: fix(sandbox-vm-native): build helper launch spec as helper argv[1] (CR-1/CR-2)

  The VM helper's argv[1] must be a base64url(JSON) helper launch spec containing rootfsPath, skillBlockPath, caBlockPath, vsockPort, vsockHostSocket, cpus, memMib, bootstrapPath, bootstrapArgv, and trustedEnv. The guest bootstrapArgv (including the CBOR blob) is nested inside this spec. Previously the engine passed the guest bootstrapArgv directly as the helper's argv, which broke the helper contract and prevented the VM from booting.

  - Added `buildHelperLaunchSpec()` in `packages/sandbox-vm-native/src/helper-launch-spec.ts` with fail-closed validation (absolute paths, no `..`, no NUL, vsockPort range, bootstrapArgv length/exactly bootstrapPath).
  - Wired it into `VmEngineImpl.start()` so the helper is spawned with `[helperPath, helperSpecToken]`.
  - Added optional `trustedEnv?: string[]` to `VmStartConfig` in `packages/sandbox/src/vm/types.ts` for Task 2's vsock environment plumbing.
  - Updated L1 fake-spawn tests to assert the new helper argv contract and decode/verify the nested spec.

- 7256c9c: fix(sandbox-vm-native): drop duplicate bootstrapPath from bootstrapArgv (libkrun argv[0] semantics)

  The VM guest died at bootstrap with `launch-spec decode/validate failed` on
  every real boot. Root cause (confirmed by an in-guest diagnostic): libkrun's
  `krun_set_exec(exec_path, argv, ...)` uses `exec_path` as the guest's argv[0]
  and **appends** the supplied `argv` array after it. The old
  `bootstrapArgv = [bootstrapPath, launchSpecBlob]` therefore produced guest
  `argv = [path, path, blob]`, so vm-init read the executable _path_ (not the
  CBOR blob) at argv[1] and failed to decode it. `bootstrapArgv` now carries
  only the blob (`[launchSpecBlob]`), yielding guest `argv = [path, blob]` with
  the blob at argv[1] as the bootstrap protocol expects. Validation invariants
  in engine.ts, helper-launch-spec.ts, and vm-helper.c updated from
  "length 2 / argv[0]===bootstrapPath" to "length 1 / argv[0]!==bootstrapPath".

  The G1/G2 qualification-gate launch specs also moved `cwd` from `/tmp` to
  `/skill`: vm-init's R7 constraint requires the workload cwd to realpath()
  under the read-only `/skill` block-image mount, so a `/tmp` cwd was rejected
  with `cwd not under /skill` even after the argv fix.

- 79c9b8f: Fix the four vm-lane L3/L4 failures surfaced now that the lane runs for real (G1/G2 GO, probe verified, manifest signed). 12/16 already passed; these close the remaining gaps.

  - **Guest env credential containment (fail-closed).** `buildGuestEnv` previously merged the _entire_ untrusted `spec.env` into the guest (`{...specEnv}`), so any host credential the caller held leaked into the VM — the L4 credential-leak escape vector. It now installs only an explicit SAFE allowlist of probe-orchestration var names (`PROBE_ACTION`, `PROBE_HOST`, `PROBE_PORT`, `HOST_CANARY_PATH`) and drops everything else, then forces the trusted proxy/CA overrides. This matches the OS sandbox's existing contract (its helper clears the env and installs only a SAFE allowlist). Unit tests updated to assert stripping + allowlist passthrough.

  - **vm-init exit-frame delivery (allowlist ⇒ exit 127).** Two coordinated fixes. (a) The post-ready `die()`/`die_errno()` paths wrote `{"error":…}{"exit":127}` then `_exit(127)` with **no settle delay** — unlike the workload path, which `usleep(50ms)`s before exiting. init.krun reboots the guest the moment it reaps PID 1, so the queued virtio-console tx was dropped by the device reset. (b) In the host engine, the exit-frame capture attached to the control stream **after** the ready handshake resolved — but `waitForReady` detaches its own `onData` on the ready frame, so a fast rejection writing `{"ready":true}{"error":…}{"exit":127}` in a SINGLE chunk had its exit frame dropped at the listener boundary. The capture now attaches **before** the handshake and stays attached post-ready, so the authoritative guest exit code is never missed. Together these ensure a rejected exec surfaces as `exitCode 127`, never the helper's always-0 fallback. `vm-init.c` is compiled into the guest rootfs by `build-vm-rootfs.mjs` (not a digest-pinned TCB artifact); the engine.ts change is TypeScript→dist. Adds a regression test asserting the exit frame is captured even in the same chunk as ready (verified to fail with the capture attached post-handshake).

  - **Probe actions + test fixes.** Added a `pid-info` probe action (`{ ok: process.pid > 1, pid }`) so the bootstrap-integrity test asserts the workload actually runs under vm-init (the previous `metadata` action only pinged the cloud IMDS endpoint and could never report a PID). Added an `http-fetch` probe action (fetch through the egress proxy with the session CA) and rewrote the L3 curl test to use `runProbe` — it previously called `backend.run()` directly and read `result.json.ok`, but `backend.run()` returns no `.json` (only `runProbe` populates it via `parseProbeJson`), so it threw `Cannot read properties of undefined`.

- d327a60: fix(sandbox): resolve the VM-lane native package from the leaf test

  The VM L3/L4 lane skipped all 16 tests on the physical Apple Silicon
  runner even after G1/G2 went green and the release manifest signed.
  `buildLaneVmEngine()` returned null: it located
  `@agentoctopus/sandbox-vm-native` via a bare
  `createRequire(import.meta.url).resolve(...)` / `import(...)` from the
  leaf `sandbox` package — but sandbox does not depend on the native
  package (only `core` does) and pnpm does not hoist it, so the resolution
  failed `MODULE_NOT_FOUND`. The skip gate then fail-closed the lane with
  zero diagnostics.

  Resolve the native package as the SIBLING workspace package anchored at
  the test file's own path (`fileURLToPath(import.meta.url)` →
  `../../../sandbox-vm-native`), and import the built engine from its
  `dist/index.js` by absolute file URL. Probe now actually runs; on a dev
  box it stops only at the (locally absent) gate manifest, and on the
  qualified lane it proceeds against the produced gate + signed release
  manifest.

- feat(sandbox): commit the VM release trust-root public key

  Replaces the empty `RELEASE_PUBLIC_KEY_BASE64` placeholder in release-key.ts
  with the production Ed25519 public key (base64 DER SPKI) matching the CI
  signing secret `OCTOPUS_VM_RELEASE_PRIVATE_KEY`. Signed release manifests
  shipped in the native package now verify at launch; a present-but-unverifiable
  manifest still fails closed (`signature-invalid`), and an absent pair still
  degrades softly (`missing`). The private seed is custody-only (GitHub secret,
  never committed). Adds trust-root unit tests and release-chain documentation
  (TEST_INSTRUCTIONS.md S18, docs/deployment/security.md).

- 42865c6: feat(sandbox): commit the VM release trust-root public key

  Replaces the empty `RELEASE_PUBLIC_KEY_BASE64` placeholder in release-key.ts
  with the production Ed25519 public key (base64 DER SPKI) matching the CI
  signing secret `OCTOPUS_VM_RELEASE_PRIVATE_KEY`. Signed release manifests
  shipped in the native package now verify at launch; a present-but-unverifiable
  manifest still fails closed (`signature-invalid`), and an absent pair still
  degrades softly (`missing`). The private seed is custody-only (GitHub secret,
  never committed). Adds trust-root unit tests and release-chain documentation
  (TEST_INSTRUCTIONS.md S18, docs/deployment/security.md).

- chore(sandbox): rotate the VM release-manifest trust root

  The previous Ed25519 public key committed in `release-key.ts` had no
  recoverable private seed — the CI secret `OCTOPUS_VM_RELEASE_PRIVATE_KEY`
  was never populated, so the vm-lane "Sign release manifest" step failed
  closed (`OCTOPUS_VM_RELEASE_PRIVATE_KEY is not set`) on every same-repo
  run even after the G1/G2 qualification gates went green.

  Per the documented ROTATION PROCEDURE: a new Ed25519 keypair was
  generated, the compiled-in `RELEASE_PUBLIC_KEY_BASE64` constant is
  replaced with the new base64 DER SPKI public key, and the CI secret is
  rotated to the new base64 seed. The private seed remains custody-only
  (GitHub secret, never in the repository). Signatures produced under the
  old key now fail closed (`bad-signature`) — by design.

- 3e5392d: chore(sandbox): rotate the VM release-manifest trust root

  The previous Ed25519 public key committed in `release-key.ts` had no
  recoverable private seed — the CI secret `OCTOPUS_VM_RELEASE_PRIVATE_KEY`
  was never populated, so the vm-lane "Sign release manifest" step failed
  closed (`OCTOPUS_VM_RELEASE_PRIVATE_KEY is not set`) on every same-repo
  run even after the G1/G2 qualification gates went green.

  Per the documented ROTATION PROCEDURE: a new Ed25519 keypair was
  generated, the compiled-in `RELEASE_PUBLIC_KEY_BASE64` constant is
  replaced with the new base64 DER SPKI public key, and the CI secret is
  rotated to the new base64 seed. The private seed remains custody-only
  (GitHub secret, never in the repository). Signatures produced under the
  old key now fail closed (`bad-signature`) — by design.

- fix(sandbox): verifyVmTcb returns the exact manifest it verified, closing the double-read substitution window

  probe() previously called verifyVmTcb() — which reads vm-tcb-manifest.json and
  verifies the on-disk binaries against it — and then re-read the same manifest
  path to build the digest set for the gate-manifest check. Between the two
  reads, an attacker could swap the file so one manifest verified the binaries
  while another's digests matched the signed gate (verification-result
  substitution). verifyVmTcb now returns { paths, manifest } — the exact
  manifest body the files were verified against — and probe() threads those
  digests without a second read.

- b43006c: fix(sandbox): verifyVmTcb returns the exact manifest it verified, closing the double-read substitution window

  probe() previously called verifyVmTcb() — which reads vm-tcb-manifest.json and
  verifies the on-disk binaries against it — and then re-read the same manifest
  path to build the digest set for the gate-manifest check. Between the two
  reads, an attacker could swap the file so one manifest verified the binaries
  while another's digests matched the signed gate (verification-result
  substitution). verifyVmTcb now returns { paths, manifest } — the exact
  manifest body the files were verified against — and probe() threads those
  digests without a second read.

- fix(sandbox-vm-native): bind VM execution to probe-verified objects (exec-path + object binding)

  - Exec-path binding: probe() realpath-enforces opts.helperPath against the
    verifyVmTcb()-verified helper BEFORE any exec (a divergent path fails
    closed and the BLK probe never runs; the probe execs the verified
    realpath). Core assembly realpath-enforces builderBinaryPath against
    artifactsDir/vm-image-builder (else unavailable), and VmImageBuilderImpl
    accepts a lazy path resolver — production wires
    () => engine.getVerifiedImageBuilderPath(), so the executed builder is the
    probe-verified one, never an independently configured path.
  - Object binding (closes the residual hash→exec TOCTOU): probe() copies the
    four verified artifacts into an engine-private 0700 dir, hashing the bytes
    as they are read for the copy from a single O_NOFOLLOW fd (digest must
    equal the verified manifest). Only those copies are executed/loaded —
    start() execs the private helper with LD/DYLD_LIBRARY_PATH forced to the
    private dir. resolveRootfs() opens the rootfs O_RDONLY|O_NOFOLLOW, hashes
    from that fd, and pins it; start() inherits it at fd 5 and the launch spec
    references /dev/fd/5, so the attached image is the verified inode even if
    the path is swapped after resolution. A post-probe swap of any TCB file or
    the rootfs is neutralized (regression-tested); only a pre-binding swap
    still fails closed on the from-fd digest check.
  - engine.close() releases the pinned rootfs fd and the private TCB dir;
    VmSandboxBackend.cleanup() invokes it (soft bucket).

- cbc1e3f: fix(sandbox-vm-native): bind VM execution to probe-verified objects (exec-path + object binding)

  - Exec-path binding: probe() realpath-enforces opts.helperPath against the
    verifyVmTcb()-verified helper BEFORE any exec (a divergent path fails
    closed and the BLK probe never runs; the probe execs the verified
    realpath). Core assembly realpath-enforces builderBinaryPath against
    artifactsDir/vm-image-builder (else unavailable), and VmImageBuilderImpl
    accepts a lazy path resolver — production wires
    () => engine.getVerifiedImageBuilderPath(), so the executed builder is the
    probe-verified one, never an independently configured path.
  - Object binding (closes the residual hash→exec TOCTOU): probe() copies the
    four verified artifacts into an engine-private 0700 dir, hashing the bytes
    as they are read for the copy from a single O_NOFOLLOW fd (digest must
    equal the verified manifest). Only those copies are executed/loaded —
    start() execs the private helper with LD/DYLD_LIBRARY_PATH forced to the
    private dir. resolveRootfs() opens the rootfs O_RDONLY|O_NOFOLLOW, hashes
    from that fd, and pins it; start() inherits it at fd 5 and the launch spec
    references /dev/fd/5, so the attached image is the verified inode even if
    the path is swapped after resolution. A post-probe swap of any TCB file or
    the rootfs is neutralized (regression-tested); only a pre-binding swap
    still fails closed on the from-fd digest check.
  - engine.close() releases the pinned rootfs fd and the private TCB dir;
    VmSandboxBackend.cleanup() invokes it (soft bucket).
