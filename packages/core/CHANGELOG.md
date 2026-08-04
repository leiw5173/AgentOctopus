# @agentoctopus/core

## 0.9.0

### Minor Changes

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

- 6bc7cd0: feat: hermes E2E acceptance gate — debug telemetry, per-skill output validators, and executionId correlation

  - `@agentoctopus/core`: ExecutionContext telemetry (traceId/executionId propagation through Router→Executor→SandboxRunner); per-skill outputValidators map on Executor (skill-name-keyed lookup, backward-compatible with single outputValidator); debugEndpoints config section; fix executionId sharing so adapter.completed and sandbox.completed events use the SAME id per execute() call.
  - `@agentoctopus/gateway`: admin debug endpoint GET /agent/debug/last-run; DebugTelemetryBuffer (per-request RunRecord aggregation by traceId, executionId-based runs[] merge, ring-buffer eviction); /ask correlation-key extraction ([trace: oct-e2e-<uuid>]) with exactly-one terminal emission; per-skill validators for weather (temperature pattern) and ip-lookup (IPv4 pattern).
  - `@agentoctopus/cli`: `octopus doctor` subcommand for environment diagnostics.
  - `@agentoctopus/sandbox`: bootstrap egress proxy integration; vendored undici for proxy HTTP forwarding.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>

- feat(core): converge all skill execution and network paths on the SandboxRunner

  Every non-MCP skill execution and network path now goes through the `SandboxRunner` built in the prior task. The `Adapter.invoke` boundary changed to `invoke(input: AdapterInput, context: AdapterInvocationContext)` where `context.sandbox` is a required, skill-bound `BoundSandboxExecutionPort`. There is no host execution fallback — where no sandbox context is available the path fails closed.

  - `SubprocessAdapter` delegates to `context.sandbox.run` (guest path `/skill/scripts/<entry>`); it no longer imports `child_process`.
  - `HttpAdapter` serializes `{method,url,headers,body}` into `OCTOPUS_INPUT` and executes a trusted in-sandbox `node -e` HTTP runner; it never host-fetches and never reads `process.env` API keys (the egress proxy injects credentials).
  - The Executor's LLM-guided subprocess and HTTP/curl paths run `bash -c <cmd>` inside the sandbox instead of host `cp.spawn('bash', ...)`; host `process.env` mutation for execution (`applySkillEnvOverrides`) was removed (credential pre-flight checks remain as read-only guards).
  - The Executor accepts an optional 4th constructor param `sandboxRunner?: SandboxRunner`; production call sites lazily build the real default from the trusted octopus.json sandbox config (`createDefaultSandboxRunner`).
  - Removed the legacy host `DockerAdapter`, `SshAdapter`, and `OpenShellAdapter` (replaced by the canonical backends in `@agentoctopus/sandbox`).
  - `McpAdapter` converged to the new signature only; its persistent transport is the next task's job.

- 34e304d: feat(core): converge all skill execution and network paths on the SandboxRunner

  Every non-MCP skill execution and network path now goes through the `SandboxRunner` built in the prior task. The `Adapter.invoke` boundary changed to `invoke(input: AdapterInput, context: AdapterInvocationContext)` where `context.sandbox` is a required, skill-bound `BoundSandboxExecutionPort`. There is no host execution fallback — where no sandbox context is available the path fails closed.

  - `SubprocessAdapter` delegates to `context.sandbox.run` (guest path `/skill/scripts/<entry>`); it no longer imports `child_process`.
  - `HttpAdapter` serializes `{method,url,headers,body}` into `OCTOPUS_INPUT` and executes a trusted in-sandbox `node -e` HTTP runner; it never host-fetches and never reads `process.env` API keys (the egress proxy injects credentials).
  - The Executor's LLM-guided subprocess and HTTP/curl paths run `bash -c <cmd>` inside the sandbox instead of host `cp.spawn('bash', ...)`; host `process.env` mutation for execution (`applySkillEnvOverrides`) was removed (credential pre-flight checks remain as read-only guards).
  - The Executor accepts an optional 4th constructor param `sandboxRunner?: SandboxRunner`; production call sites lazily build the real default from the trusted octopus.json sandbox config (`createDefaultSandboxRunner`).
  - Removed the legacy host `DockerAdapter`, `SshAdapter`, and `OpenShellAdapter` (replaced by the canonical backends in `@agentoctopus/sandbox`).
  - `McpAdapter` converged to the new signature only; its persistent transport is the next task's job.

- a093b07: Converge every untrusted skill execution and network path on fail-closed sandbox backends. Adds canonical trusted/request schemas, immutable snapshot-only invocation payloads, backend-aware egress proxy and CA topology, persistent duplex sandbox processes for MCP, digest-pinned runtime profiles, stable installation identities, and secret-provider isolation. Removes host subprocess/network/bin-install fallbacks and unsupported legacy OpenShell behavior.
- 9b792d8: Sandbox run/session outputs now carry the full machine-readable SandboxResultMeta from the backend result verbatim. run() awaits cleanup before returning and downgrades to isolationLevel 'none' on ContainmentCleanupError; persistent sessions expose resultMeta, definitive only after close(). Session-dir and proxy-close failures surface as degradation reasons without downgrading isolation.
- 1d8210c: refactor(core): isolate credentials behind sandbox secret provider

  Credential VALUES are now isolated behind a host-side `SecretProvider` and reach ONLY the trusted egress proxy via `SandboxRunner.provisionSecrets` — never an LLM prompt, an `ExecSpec.env`, a log, an error, or global `process.env`.

  - Removed the credential-value interpolation from the Executor's LLM-guided subprocess (`subCredContext`) and HTTP (`credContext`) prompts, and deleted the broad `commonKeyPattern` scan that pushed `KEY = <value> (available in env)` into the prompt. Guided-path prompts now carry at most credential KEY NAMES plus a value-free `configured`/`not configured` boolean.
  - Added `buildSecretProviderFromConfig(config)` (`packages/core/src/secret-provider.ts`) which builds a `MapSecretProvider` seeded from trusted sources (credential-shaped `process.env`, `config.credentials`, and `skills.entries[*].apiKey`/`env`). Values stay inside the provider and are never logged.
  - `createDefaultSandboxRunner(secretProvider?)` now accepts an optional provider; the no-arg form still works (empty provider) for call sites that cannot reach the LLM-guided credential paths (web singleton, multi-agent instances).
  - Wired the provider at the composition roots that have config in scope: gateway `engine.ts` and the CLI `bootstrap()`. Web `ask/route.ts` and `multi-agent/agent-instance.ts` intentionally remain on the default runner (deferred — no chatClient/config in scope there).
  - `diagnoseAuthError`'s credential-presence read now uses the same read-only effective view (`effectiveCredentialEnv`) as the pre-flight guard; only presence is ever read, never values.

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

### Patch Changes

- 8bae9be: Align the onboarding wizard and agent sandbox config to feat/sandbox's fail-closed schema. The wizard previously offered `openshell` (a local pass-through with no real isolation) and wrote `docker.network: 'none'` plus a mutable `node:20-alpine` image tag — all removed by the canonical `SandboxConfigSchema` (docker.image must be an immutable digest; the egress proxy is the sole network egress). The wizard now offers `auto` (fail-closed best available, recommended), `docker`, `os` (restricted opt-in), `vm` (microVM), and `ssh`, and writes only `defaultBackend` so the resolver applies schema defaults. `AgentConfigSchema.sandbox.backend` in core is widened to the canonical enum to match.
- 2111809: Each sandbox session now uses a unique private 0700 working directory, and the per-session egress-proxy CA bundle is created exclusively inside it and removed at cleanup, eliminating shared ca.pem overwrite across concurrent sessions. Session-dir removal failure is treated as host hygiene, not containment.
- f4304ea: Mark the dynamic `import('@agentoctopus/sandbox-vm-native')` with `/* webpackIgnore: true */` so Turbopack (Next.js web app) does not statically resolve and bundle it. The VM backend is a runtime-only optional native package (libkrun microVM); Turbopack would otherwise pull in koffi's native `.node` binding — a "non-ecmascript placeable asset" that fails the apps/web build. `serverExternalPackages` cannot externalize a dynamic-import specifier. With webpackIgnore, the import is left as-is: plain Node (CLI, gateway) resolves it normally; the web app's serverless runtime throws, and createVmBackend's catch returns the fail-closed `unavailable` path it already takes (the web app never selects the VM backend).
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

- 14d1d78: Resolve VM native prebuilds via the package graph (F4).

  defaultPrebuildRoot() walked up from import.meta.url to find
  packages/sandbox-vm-native — correct in the monorepo source tree, but in an
  npm install core/dist/ lives at node_modules/@agentoctopus/core/dist/, so the
  walk resolved to node_modules/packages/sandbox-vm-native (nonexistent). The
  existence check converted that into a clean unavailable, but an installed
  @agentoctopus/core could never locate the VM prebuilds even when
  @agentoctopus/sandbox-vm-native was installed alongside it.

  Resolve the native package's prebuilds/<platform> dir via
  require.resolve('@agentoctopus/sandbox-vm-native/package.json') first (walks
  node_modules the same way import does), falling back to the source-tree walk
  only for monorepo dev. The helper and image-builder paths now derive from one
  consistent resolved dir.

- 70871f7: Ensure a persistent sandbox MCP transport releases its runner-owned session when the peer exits, reaping the sandbox process and cleaning backend/proxy resources. Add a real Docker end-to-end lane through `SandboxRunner.bind()` and the production `SandboxMcpTransport`, covering multi-message persistence, malformed frames, peer exit, and deterministic process-tree cleanup.
- Add the release-blocking sandbox security matrix and immutable runtime supply chain. The runtime image has no entrypoint or shell/network clients and executes direct argv; the egress-proxy image is self-contained. Docker, privileged Linux, proxy, persistent MCP, identity/snapshot, and macOS restricted/fail-closed lanes now prove host-canary isolation, proxy-only egress, credential scoping, redirect/framing/smuggling/DNS/TLS defenses, resource and process-tree cleanup, and digest sensitivity. Release preflight and publish require successful security results for the exact release SHA and immutable image digests.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>

- e45c517: Add the release-blocking sandbox security matrix and immutable runtime supply chain. The runtime image has no entrypoint or shell/network clients and executes direct argv; the egress-proxy image is self-contained. Docker, privileged Linux, proxy, persistent MCP, identity/snapshot, and macOS restricted/fail-closed lanes now prove host-canary isolation, proxy-only egress, credential scoping, redirect/framing/smuggling/DNS/TLS defenses, resource and process-tree cleanup, and digest sensitivity. Release preflight and publish require successful security results for the exact release SHA and immutable image digests.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>

- fix(sandbox-vm-native): unified vm-tcb-manifest with imageBuilder (HI-3)

  - `packages/sandbox-vm-native/scripts/build-vm-helper.mjs` now builds the
    `vm-image-builder` TCB artifact (from `src/vm-image-builder.c`) and writes
    its per-artifact manifest, then aggregates helper/libkrun/libkrunfw/imageBuilder
    into ONE combined `prebuilds/<platform>/vm-tcb-manifest.json` with each entry
    `{sha256, size, mode}`.
  - `packages/sandbox-vm-native/scripts/run-vm-gates.mjs` reads artifact refs from
    the combined `vm-tcb-manifest.json` instead of four separate per-artifact files.
  - New shared helper `packages/sandbox-vm-native/scripts/tcb-manifest.mjs` exports
    `buildTcbManifest()` (producer), `readArtifactRefsFromTcbManifest()` (gate),
    and `readPerArtifactEntry()`.
  - Fail-closed invariant: if the imageBuilder artifact or its per-artifact manifest
    is absent/malformed, `buildTcbManifest()` throws and writes no combined manifest.
    If the combined manifest is missing or malformed, `readArtifactRefsFromTcbManifest()`
    throws. `verifyVmTcb` rejection during the build self-check is now fatal.
  - `packages/core/src/sandbox-vm-assembly.ts` defaults `tcbManifestPath` to
    `prebuilds/<platform>/vm-tcb-manifest.json` to match the unified manifest.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>

- 97a3585: fix(sandbox-vm-native): unified vm-tcb-manifest with imageBuilder (HI-3)

  - `packages/sandbox-vm-native/scripts/build-vm-helper.mjs` now builds the
    `vm-image-builder` TCB artifact (from `src/vm-image-builder.c`) and writes
    its per-artifact manifest, then aggregates helper/libkrun/libkrunfw/imageBuilder
    into ONE combined `prebuilds/<platform>/vm-tcb-manifest.json` with each entry
    `{sha256, size, mode}`.
  - `packages/sandbox-vm-native/scripts/run-vm-gates.mjs` reads artifact refs from
    the combined `vm-tcb-manifest.json` instead of four separate per-artifact files.
  - New shared helper `packages/sandbox-vm-native/scripts/tcb-manifest.mjs` exports
    `buildTcbManifest()` (producer), `readArtifactRefsFromTcbManifest()` (gate),
    and `readPerArtifactEntry()`.
  - Fail-closed invariant: if the imageBuilder artifact or its per-artifact manifest
    is absent/malformed, `buildTcbManifest()` throws and writes no combined manifest.
    If the combined manifest is missing or malformed, `readArtifactRefsFromTcbManifest()`
    throws. `verifyVmTcb` rejection during the build self-check is now fatal.
  - `packages/core/src/sandbox-vm-assembly.ts` defaults `tcbManifestPath` to
    `prebuilds/<platform>/vm-tcb-manifest.json` to match the unified manifest.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>

- 3333869: Add Vercel deployment configuration and Anthropic provider support

  - Add `vercel.json` for monorepo deployment settings
  - Add `.vercelignore` to exclude unnecessary files from deployment
  - Add `packageManager` field to web app for pnpm detection
  - Add Anthropic provider support to LLM client

- 674ed49: Make the F4 vm-assembly test robust to locally-built (gitignored) VM prebuilds.

  `createVmBackend`'s F4 test asserted the backend always returns `{unavailable}`
  when no explicit `helperPath` is configured — the prebuilds dir was assumed
  empty on a clean checkout. A locally-built (gitignored) `sandbox-vm-helper` +
  `vm-image-builder` in `prebuilds/darwin-arm64/` (e.g. produced while debugging
  the VM lane on a dev machine) flips that to a full backend, failing the
  assertion. The test now accepts either outcome:

  - `{unavailable}` (fresh checkout) — the reason must still echo a path under
    `sandbox-vm-native/prebuilds/<platform>` (package-graph resolution), never
    the broken `node_modules/packages/sandbox-vm-native` source-tree walk;
  - a `kind: 'vm'` backend (locally-built prebuilds) — the resolution itself
    proves the package graph worked, since the broken walk would always resolve
    to a nonexistent path and thus return unavailable.

  This is test-only; no runtime behavior change. (It also un-gates `pnpm test`
  on dev machines that have built VM prebuilds locally.)

- fix(sandbox-vm-native): bind the release signature to the loaded gate manifest and fail closed on deletion

  - probe() now parses the Ed25519-signed release-manifest body after signature
    verification and requires canonical-digest equality with the gate manifest
    actually loaded, closing the mixed-state attack (a legitimately-signed old
    release manifest + swapped gate manifest / TCB / binaries).
  - A half pair (exactly one of release-manifest.json / .sig present) now fails
    closed unconditionally, and a file deleted between the existence check and
    the read (TOCTOU) fails closed instead of soft-degrading.
  - New engine option requireReleaseSignature, set by core's production
    buildEngineOpts, makes a release build fail closed when the signed pair is
    absent instead of degrading to unsigned dev mode. Dev boxes and CI harnesses
    that build engine opts without the flag keep the soft 'missing' path.

- a28c8ab: fix(sandbox-vm-native): bind the release signature to the loaded gate manifest and fail closed on deletion

  - probe() now parses the Ed25519-signed release-manifest body after signature
    verification and requires canonical-digest equality with the gate manifest
    actually loaded, closing the mixed-state attack (a legitimately-signed old
    release manifest + swapped gate manifest / TCB / binaries).
  - A half pair (exactly one of release-manifest.json / .sig present) now fails
    closed unconditionally, and a file deleted between the existence check and
    the read (TOCTOU) fails closed instead of soft-degrading.
  - New engine option requireReleaseSignature, set by core's production
    buildEngineOpts, makes a release build fail closed when the signed pair is
    absent instead of degrading to unsigned dev mode. Dev boxes and CI harnesses
    that build engine opts without the flag keep the soft 'missing' path.

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

- Updated dependencies [e0d70e8]
- Updated dependencies [82c1482]
- Updated dependencies [981ed72]
- Updated dependencies [907f4ea]
- Updated dependencies [c42c0b3]
- Updated dependencies [527f236]
- Updated dependencies [7208e49]
- Updated dependencies [5e85d3b]
- Updated dependencies [817e0c6]
- Updated dependencies [d4b64f2]
- Updated dependencies [3f54a3c]
- Updated dependencies [6bc7cd0]
- Updated dependencies
- Updated dependencies [689d833]
- Updated dependencies [eca3a3e]
- Updated dependencies [119a837]
- Updated dependencies
- Updated dependencies [773f76c]
- Updated dependencies [d0db1d7]
- Updated dependencies
- Updated dependencies [07980ee]
- Updated dependencies
- Updated dependencies [0f6ed4d]
- Updated dependencies [93d29b7]
- Updated dependencies
- Updated dependencies [e9f39ae]
- Updated dependencies [1c4e384]
- Updated dependencies
- Updated dependencies [575141f]
- Updated dependencies [94f4ca6]
- Updated dependencies [4cd6484]
- Updated dependencies [57f8e82]
- Updated dependencies
- Updated dependencies [521e64d]
- Updated dependencies [4876e12]
- Updated dependencies [c83e5c1]
- Updated dependencies
- Updated dependencies [395a999]
- Updated dependencies
- Updated dependencies [1da822a]
- Updated dependencies
- Updated dependencies [56d6b8b]
- Updated dependencies
- Updated dependencies [34e304d]
- Updated dependencies [a093b07]
- Updated dependencies [4360716]
- Updated dependencies [70871f7]
- Updated dependencies [763827c]
- Updated dependencies
- Updated dependencies [79e7d44]
- Updated dependencies [9b792d8]
- Updated dependencies [651f879]
- Updated dependencies
- Updated dependencies [e45c517]
- Updated dependencies
- Updated dependencies [be42fa1]
- Updated dependencies
- Updated dependencies [0c5eea9]
- Updated dependencies [146ef8f]
- Updated dependencies [c449e9d]
- Updated dependencies [a27bf3d]
- Updated dependencies [000a440]
- Updated dependencies
- Updated dependencies [1442cc7]
- Updated dependencies
- Updated dependencies [7783966]
- Updated dependencies
- Updated dependencies [e2fc1d9]
- Updated dependencies
- Updated dependencies [4c0ac2c]
- Updated dependencies [c0343ed]
- Updated dependencies [a525160]
- Updated dependencies [44297c0]
- Updated dependencies [1cf3c5f]
- Updated dependencies [7256c9c]
- Updated dependencies [79c9b8f]
- Updated dependencies [d327a60]
- Updated dependencies
- Updated dependencies [42865c6]
- Updated dependencies
- Updated dependencies [3e5392d]
- Updated dependencies
- Updated dependencies [b43006c]
- Updated dependencies
- Updated dependencies [cbc1e3f]
  - @agentoctopus/sandbox@0.9.0
  - @agentoctopus/registry@0.9.0
  - @agentoctopus/adapters@0.9.0
  - @agentoctopus/skills@0.9.0

## 0.8.0

### Minor Changes

- 858f227: Add install preference helpers to config resolver

  `getInstallPref(bin)` reads per-binary installation preference from
  ~/.agentoctopus/octopus.json. `saveInstallPref(bins, preference)` writes
  preferences and invalidates the in-memory config cache.

  SkillsConfigSchema gains `installPrefs: Record<string, "always" | "never" | "prompt">`.

- 858f227: Add binary auto-install support for skill execution

  When a skill requires missing binaries and declares install specs in its SKILL.md metadata (`openclaw.install`), the system now offers interactive installation instead of failing silently.

  - **New result types**: `binary_installable` (can be installed) and `binary_install_failed` (install attempted but failed with manual instructions)
  - **CLI**: Interactive prompt with always/never/prompt preferences saved to config
  - **REST API** (`/agent/ask`): Returns `binary_installable` with `installSpecs`; accepts `autoInstall: true` to trigger automatic install
  - **Chat channels** (Slack/Discord/Telegram/Webchat): Two-phase session flow — sends confirmation prompt, installs on "yes" reply
  - **Web API** (`/api/ask`): Same `binary_installable`/`binary_install_failed` response types; accepts `autoInstall` in request body
  - **Install specs**: Supports `brew`, `node`, `go`, `uv`, and `download` kinds with platform-aware filtering

### Patch Changes

- 858f227: Fix subprocess adapter to auto-chmod scripts before execution (ClawHub downloads may not preserve +x)
- bbad3b9: Bump TypeScript 5.9→6.0 and Zod 3→4 with required tsconfig and API fixes

  - Add `"types": ["node"]` to root tsconfig.json (TS 6.0 no longer auto-includes @types/node)
  - Migrate `z.record(V)` → `z.record(z.string(), V)` for Zod 4 compatibility

- 858f227: Fix reranker selection being ignored, add session context for follow-up queries, improve rerank disambiguation prompt
- ac3a715: fix(registry): pass maxCandidates: Infinity to loadSkillsFromDir so all skills are loaded instead of being capped at 300
  fix(core): handle non-array tags in skillToText before .join() to prevent gateway startup crash
  docs: fix TEST_INSTRUCTIONS.md Phase 3 test commands — correct import path and repo root
- Updated dependencies [858f227]
- Updated dependencies [858f227]
- Updated dependencies [858f227]
- Updated dependencies [858f227]
- Updated dependencies [bbad3b9]
- Updated dependencies [ac3a715]
  - @agentoctopus/adapters@0.8.0
  - @agentoctopus/skills@0.8.0
  - @agentoctopus/registry@0.8.0

## 0.7.0

### Minor Changes

- afdd379: Add AI-driven skill evolution: signal collection, LLM analysis, safe/risky proposal dispatch, shadow-copy rollback, CLI review commands, and onboard opt-in

### Patch Changes

- Updated dependencies [afdd379]
  - @agentoctopus/skills@0.7.0
  - @agentoctopus/registry@0.7.0
  - @agentoctopus/adapters@0.7.0

## 0.6.1

### Patch Changes

- @agentoctopus/skills@0.6.1
- @agentoctopus/registry@0.6.1
- @agentoctopus/adapters@0.6.1

## 0.6.0

### Minor Changes

- 2b4a5da: Add local scored skill search — octopus search now searches installed skills with relevance scoring. Add --run flag for interactive pick-and-run execution.

### Patch Changes

- Updated dependencies [2b4a5da]
  - @agentoctopus/skills@0.6.0
  - @agentoctopus/registry@0.6.0
  - @agentoctopus/adapters@0.6.0

## 0.5.19

### Patch Changes

- Bump dependencies: vectra 0.6.0→0.14.0, @google/generative-ai 0.15.0→0.24.1, @modelcontextprotocol/sdk 1.27.1→1.29.0, @types/node 20.19.37→25.6.0, eslint 9.39.4→10.3.0.
- Updated dependencies
  - @agentoctopus/skills@0.5.19
  - @agentoctopus/registry@0.5.19
  - @agentoctopus/adapters@0.5.19

## 0.5.17

### Patch Changes

- 48d4f1c: Rebuild CI/CD pipeline: preflight+promotion publishing, OIDC npm auth, changeset-driven versioning, composite action for DRY setup
- Updated dependencies [48d4f1c]
  - @agentoctopus/skills@0.5.17
  - @agentoctopus/registry@0.5.17
  - @agentoctopus/adapters@0.5.17
