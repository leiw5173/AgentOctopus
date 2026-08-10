# Sandbox Execution

AgentOctopus executes every skill inside a sandbox backend selected at runtime (Docker, OS-native, or platform-restricted). All orchestration — snapshotting, policy resolution, proxy launch, path rewriting, and cleanup — lives in one place: the `SandboxRunner` in `@agentoctopus/core`.

## Per-session working directory

Each execution gets a **unique private working directory**:

- Created with `mkdtemp` under `<snapshotStoreDir>/sessions/oct-session-*`
- Mode `0700` — private to the owning session
- Passed to the egress-proxy launcher as `workDir`
- Removed in **every** exit path (success, run error, prepare failure, spawn close), always after the proxy handle is closed

Session-dir removal is best-effort host filesystem hygiene. A removal failure is never treated as a skill-containment error and never throws from cleanup.

## Per-session CA bundle

The egress proxy uses a per-session MITM CA (`SessionCa`) whose private key lives only in memory for the duration of one execution. The CA certificate is written to `<sessionDir>/ca.pem`:

- **Exclusive creation** — written with the `wx` flag, so a second write to the same directory rejects with `EEXIST` instead of silently overwriting a live session's CA
- **Mode `0444`** — readable but never writable by the sandboxed child
- Mounted into the guest read-only at `/etc/skill-ca/ca.pem`

Because each session has its own workDir, concurrent sessions can never overwrite each other's CA bundle.

## Snapshot integrity

Skills never execute from their live directory. The runner builds a content-addressed snapshot, then verifies the digest immediately before backend preparation. Any mutation between build and verify aborts the run with `SNAPSHOT_MISMATCH`.

The runner also hands the backend the exact `identity.digest` it built and verified as `BackendPrepareOptions.expectedSnapshotDigest` (format: `sha256:` + 64 lowercase hex, validated against the exported `SNAPSHOT_DIGEST_RE`). Each backend asserts the digest FORMAT before any mount; the full byte-for-byte re-verify against the snapshot tree remains the runner's duty as the last filesystem operation before `backend.prepare()`.

## Runtime-profile ↔ backend cross-check

After `selectBackend` and BEFORE any topology creation or proxy launch, the runner rejects a trusted runtime profile that cannot satisfy the selected backend with `RUNTIME_BACKEND_MISMATCH`:

- `docker` backend → profile requires `dockerImage` (rejects a `darwinRuntime`-only profile)
- `os` backend at `full` isolation (Linux) → profile requires `osRuntime` (rejects a `darwinRuntime`-only profile)
- `os` backend at `restricted` isolation (Darwin) → profile requires `darwinRuntime` (rejects `dockerImage`-only and `osRuntime`-only profiles)
- `windows` backend at `restricted` isolation → profile requires `windowsRuntime` (rejects `dockerImage`-only, `osRuntime`-only, and `darwinRuntime`-only profiles)

A **mixed** profile carrying several identity blocks satisfies each backend via the field relevant to that backend, so one trusted profile can serve both Linux and macOS hosts. The fail-fast guarantees a mismatched config never creates topology or starts a proxy.

## Trusted Darwin runtime identity

A trusted `runtimeProfiles` entry may declare `darwinRuntime.manifestPath` — the host path of the verified macOS Node runtime closure manifest used by the Darwin restricted OS backend. The manifest is trusted config (never skill input) and the nested object is strict: unknown fields are rejected at config parse time. On Darwin the bare `node` command maps directly to the verified executable from the closure; the guest PATH is derived from that executable's directory, never from the profile's `path` field (which only applies to Linux/Docker guests).

## Trusted Windows runtime identity

A trusted `runtimeProfiles` entry may declare `windowsRuntime` — `{ manifestPath, nodePath, bootstrapPath }`, the verified Windows Node runtime closure (Node exe + `bootstrap.cjs` + vendored undici) used by the Windows restricted backend. The manifest is verified at `probe()` with strict digest + size checks per entry (sha256 and byte size; there is no executable-mode bit on NTFS, so — unlike the Darwin runtime manifest — no mode check). The nested object is strict, so unknown fields are rejected at config parse time. The helper launches the skill via `windowsRuntime.nodePath` with `NODE_OPTIONS=--require <windowsRuntime.bootstrapPath>` so every `fetch`/`http`/`https` call converges on the per-session egress proxy.

## Windows restricted backend

The `WinSandboxBackend` (`packages/sandbox/src/windows/win-backend.ts`) executes skills on a bare Windows 10/11 host — no WSL, no Docker Desktop, no Hyper-V. Its isolation target is **`restricted`, never `full`**: it is not a VM and provides no kernel-memory or side-channel isolation. Selection mirrors the restricted-OS opt-in contract: a `kind:'windows'` backend reporting `restricted` is selectable **only** when `defaultBackend:'windows'` AND `minIsolationLevel:'restricted'`; under `auto`, or with any `full` floor, it is excluded even when `probe()` succeeds.

The backend layers four user-mode Windows primitives:

- **Job Object** — resource limits (memory, CPU time, process count) plus `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` for guaranteed process-tree teardown. Launch is race-free: `CreateProcess(... CREATE_SUSPENDED ...)` → `SetInformationJobObject` → `AssignProcessToJobObject` → `ResumeThread`, so the child is inside the Job before any user code runs. The Job is **named** so a separate teardown path (or a fresh helper after a TS crash) can terminate it cross-process.
- **Restricted token** — the child is launched via `CreateProcessWithTokenW` under a `CreateRestrictedToken`-hardened token at Low Integrity Level: `DISABLE_MAX_PRIVILEGE` strips every privilege except `SeChangeNotifyPrivilege`, and the Administrators group is deny-only. (`CreateProcessWithTokenW` rather than `CreateProcessAsUserW`: the latter needs `SeAssignPrimaryTokenPrivilege`, which only service tokens carry.) This is **restricted process isolation, not AppContainer capability isolation** — the LPAC/AppContainer token is deliberately NOT used on the execution path (it is the confirmed necessary trigger of the Node launch crash — the crash surfaces as a Winsock initialization failure, `WSAStartup` error 10107, immediately before the `STATUS_BREAKPOINT` fail-fast — so Node cannot start under it). The LPAC path is retained only as a diagnostic/future-compat probe. File/registry access is the restricted token's normal DACL view at Low Integrity (no write-up), not an AppContainer capability grant.
- **Session-private node.exe launch location** — a host toolchain node.exe (e.g. under `C:\hostedtoolcache`) is **unopenable by the Low-integrity token** (the launch access probes fail `ERROR_ACCESS_DENIED` on that path — a path-based denial, since the identical bytes under the session's temp dir open fine). The backend therefore copies the trusted closure's node.exe into the per-session staging dir and launches **that copy**; the copy keeps the default Medium mandatory label, so the Low child can read+execute it while `NO_WRITE_UP` still blocks the child from rewriting its own interpreter. The same copy path is the WFP APP_ID key (below), so the egress gate matches the process actually launched.
- **Persistent WFP egress allowlist** — the restricted token is not an AppContainer, so it carries no package SID and its network boundary is the WFP allowlist itself. A set of **persistent** Windows Filtering Platform filters scoped to the sandbox `node.exe` **application ID** (`FWPM_CONDITION_ALE_APP_ID`, the canonicalized binary path) permits only `TCP 127.0.0.1:<proxyPort>` (and `TCP [::1]:<proxyPort>` when the proxy dual-binds) and blocks everything else for that binary: all other V4/V6, all UDP, internet, LAN, and every other loopback port. The egress proxy is the only reachable endpoint; a skill that ignores the proxy has no network at all. Persistent (not dynamic) filters mean a crash can only leave a fail-closed block, never widened access. (APP_ID keys the session-private node.exe copy the child launches; the copy's default Medium label blocks the Low child rewriting its own exe, and the trusted closure directory stays ACL'd write-restricted so the copy's source cannot be swapped out.)
- **Privileged companion service** — WFP filter add/remove requires administrator rights, so a minimal auto-start Windows service (`OctopusSandboxGate`, LocalSystem) owns all WFP writes. It is installed once, elevated; per-skill execution itself stays unprivileged. The service exposes a strictly-ACL'd named-pipe RPC (`\\.\pipe\octopus-sandbox-gate`, DACL limited to Administrators/LocalSystem/the interactive user) with **exactly two operations** — `install-gate` and `remove-gate` — and is not a general WFP write proxy. On `remove-gate` the service itself resolves the session lease, opens the named Job, and refuses deletion unless the Job is confirmed dead/empty and the recorded filter keys match the lease (it does not trust the caller).

**Snapshot delivery is a per-session copy.** Windows shares the host filesystem namespace (no bind-map), so `prepare()` stages a per-session copy of the verified snapshot + CA and re-verifies it byte-for-byte against `expectedSnapshotDigest` (TOCTOU guard). The restricted token reads the copy through its normal Low-Integrity DACL view — there is no AppContainer package grant. Cleanup deletes the whole session directory — the shared snapshot store's DACL is never edited. The backend's `guestSkillRoot`/`guestCaBundlePath` are these staged-copy paths (each backend asserts its own canonical values; docker/linux/vm keep the Linux literals).

**Cleanup ordering is containment-critical.** `cleanup()` terminates the named Job and confirms it empty **before** asking the service to remove the WFP filters: if the Job cannot be confirmed dead the filters stay and a `ContainmentCleanupError` is thrown (never delete the gate while the process may be alive). A post-death filter-removal failure leaves a leftover *block* filter — fail-closed residue, a soft degradation, not a containment breach. Cleanup memoizes the first outcome (identical contract to the other backends).

**Availability precondition (honest):** the backend is available only when the companion service is installed and responsive — `probe()` verifies the trusted runtime manifest, self-tests the helper (Job Object + capability-SID derivation + a throwaway AppContainer-profile round-trip as a host-capability check), and installs + removes a throwaway gate; any failure returns `false` and `selectBackend` omits the backend. The AppContainer self-test is a capability probe only — the node execution path itself runs under the restricted token, not an AppContainer. There is **no unprivileged degraded mode**: without the service there is no Windows sandbox, and the run fail-closes per `minIsolationLevel`. Skills declare eligibility with `os: [windows]` (the router compares the exact string `windows`, not `win32`); skills that omit `os` are eligible on Windows and must actually work there.

## Env hygiene

The guest environment is a minimal allowlist (`LANG`, `LC_ALL`, `TZ`) plus non-reserved caller keys and fixed guest values (`HOME=/tmp/home`, `TMPDIR=/tmp`, runtime-profile `PATH`). Host `process.env` is never spread into the sandbox, and credentials never enter child env, argv, or logs — only the trusted egress proxy receives grant-scoped credential values.

## Result metadata and cleanup-uncertainty propagation

Every `SandboxRunOutput` and persistent `SandboxSession` carries the full machine-readable `SandboxResultMeta` describing the isolation actually achieved:

```ts
interface SandboxResultMeta {
  isolationLevel: IsolationLevel;          // 'full' | 'restricted' | 'remote-unverified' | 'none'
  backend: BackendKind;                    // 'docker' | 'os' | 'subprocess' | 'ssh' | 'none'
  degraded: boolean;
  degradationReasons: string[];            // never contains credential/grant material
}

interface SandboxRunOutput {
  success: boolean;
  rawText?: string;
  stderr?: string;
  error?: string;
  isolationLevel: IsolationLevel;          // pass-through mirror of meta.isolationLevel
  backend: BackendKind | 'none';           // pass-through mirror of meta.backend
  meta: SandboxResultMeta;                 // REQUIRED — verbatim from the backend on success
}
```

The runner pins the one-shot `run()` control flow:

1. Capture the backend's `BackendRunResult` (or run error).
2. Run cleanup AFTER capture, BEFORE any return — `backend.cleanup()` → `proxyHandle.close()` → `rm(sessionDir)`.
3. Build the output LAST, applying the downgrade taxonomy below.

**Downgrade taxonomy.** When `backend.cleanup()` throws a `ContainmentCleanupError` (backend process/network teardown failed — e.g. cgroup kill refused, runtime container removal errored), the runner DOWNGRADES the reported `meta.isolationLevel` to `'none'`, marks `degraded: true`, appends the containment reasons, and forces `success: false` — even if the child exited cleanly, because the isolation boundary may not have been fully torn down. Soft teardown failures (proxy close, session-dir removal) are appended to `degradationReasons` WITHOUT downgrading the level and without forcing `success: false`.

**Persistent sessions.** `SandboxSession.resultMeta` is a memoized promise that resolves ONLY after `process.exited` settles AND `close()` completes (process close → backend cleanup → proxy close → session-dir removal). It is definitive only post-close; reading it before `close()` resolves yields a pending promise by design. `close()` applies the same downgrade taxonomy, memoizes the first outcome, and rethrows the first `ContainmentCleanupError` — repeat `close()` calls rethrow the same first error instance; they never re-run teardown.

**Backend cleanup contract.** Every `SandboxBackend.cleanup()` implementation throws `ContainmentCleanupError` when its process or network teardown step fails; the call is idempotent via memoized first outcome (repeat calls rethrow the same error or resolve identically); and a containment failure is never logged-and-swallowed. Host-filesystem hygiene failures (rootfs cleanup, launch-spec removal, session-dir removal) are NOT containment — they remain best-effort and surface only as soft degradation reasons.

## Topology diagrams

### Docker runtime + proxy sidecar (internal network)

```
┌──────────────────────── host ─────────────────────────┐
│                                                         │
│   ┌─ internal network (octopus-sbx-*) ──────────────┐ │
│   │                                                   │ │
│   │   ┌─────────────────────┐    ┌─────────────────┐  │ │
│   │   │  runtime container   │    │  egress-proxy    │  │ │
│   │   │  (immutable digest)  │    │  (immutable dig) │  │ │
│   │   │                     │    │                  │  │ │
│   │   │  skill argv direct  │───►│  :8080           │  │ │
│   │   │  (no shell/curl)    │    │  requested∩granted│ │ │
│   │   │                     │    │  allowlist       │  │ │
│   │   │  /etc/skill-ca/     │    │                  │  │ │
│   │   │   ca.pem (ro bind)  │    │  ── upstream ───►│──┼─┼──► allowed egress only
│   │   └─────────────────────┘    └─────────────────┘  │ │
│   │          ▲                        ▲               │ │
│   └──────────┼────────────────────────┼───────────────┘ │
│              │                        │                 │
│        host canary (NOT mounted)  CA bundle (ro)        │
│        → unreadable + unwritable   written to sessionDir│
│                                                         │
└─────────────────────────────────────────────────────────┘
```

The runtime container's only network peer is the proxy at `http://egress-proxy:8080` on the internal network. Direct internet, cloud metadata (`169.254.169.254`), and loopback services are unreachable. The CA bundle is bind-mounted read-only at `/etc/skill-ca/ca.pem`.

### Linux skill netns + proxy netns (privileged runner, CI-owned)

```
┌─────── privileged Linux host (CAP_SYS_ADMIN + CAP_NET_ADMIN) ───────┐
│                                                                       │
│   ┌─ skill netns ──────────┐         ┌─ proxy netns ────────────────┐ │
│   │                        │         │                               │ │
│   │  skill process         │  veth   │  egress-proxy :8080           │ │
│   │  (direct argv)         │◄───────►│  requested∩granted allowlist │ │
│   │                        │ /32 only│                               │ │
│   │  route: proxy /32 ONLY │  route  │  ── upstream ──────────────► │─┼─► allowed egress
│   │  NO default route      │         │                               │ │
│   │  NO NAT                │         │  CA bundle (ro bind)          │ │
│   │                        │         │  nft + cgroup-v2 enforced     │ │
│   └────────────────────────┘         └───────────────────────────────┘ │
│                                                                       │
│   cgroup: oct-* under delegated parent (kill + remove on cleanup)    │
└───────────────────────────────────────────────────────────────────────┘
```

The skill namespace has only a `/32` route to the proxy namespace over a veth pair — no NAT, no default route, no other reachable port. nftables enforces the allowlist and cgroup-v2 enforces resource limits and process-tree reaping. This lane is CI-owned and zero-skip; it is never claimed from macOS.

### macOS restricted / unavailable + fail-closed default

```
┌──────────────────── Darwin host ────────────────────┐
│                                                      │
│   selectBackend(auto, minIsolationLevel:'full')      │
│          │                                           │
│          ▼                                           │
│   OsSandboxBackend.probe() → false (platform gate)  │
│   post-probe isolationLevel = 'restricted' (≠ full) │
│          │                                           │
│          ▼                                           │
│   No backend meets 'full' floor                     │
│          │                                           │
│          ▼                                           │
│   ✗ NoFullBackendError  (NEVER a host fallback)     │
│                                                      │
│   ── restricted opt-in (explicit, trusted only) ──  │
│   defaultBackend:'os' + minIsolationLevel:'restricted'│
│          │                                           │
│          ▼                                           │
│   probeMacSandbox() available?                      │
│     yes → sandbox-exec ENFORCES deny rules           │
│            (canary rw denied, TCP denied, env sanitized)│
│     no  → restricted unavailable, release-gate asserts│
│                                                      │
│   macOS is NEVER 'full'. Restricted is opt-in only.  │
└──────────────────────────────────────────────────────┘
```

The dyld shared-cache feasibility gate proved `file-read-data` containment cannot be established on macOS 26.x, so the restricted production backend was abandoned and a VM backend supersedes it for full isolation. Restricted use on macOS is an explicit, trusted opt-in; `auto` never picks it and the default `full` floor fails closed without Docker.

## Skill networking (egress)

The Docker runtime image is distroless: it contains only a `node` binary. There is no shell, no `curl`/`wget`, and no `ca-certificates` package. Skills are expected to use Node's built-in `fetch`.

Node v22's built-in `fetch` (undici) does not honor `HTTP_PROXY` or `HTTPS_PROXY` environment variables, and importing `node:undici`'s `setGlobalDispatcher` does not affect the built-in dispatcher. If nothing else were done, a skill calling `fetch` would attempt a direct connection and fail closed with `EAI_AGAIN` because guest DNS is disabled.

To route all built-in `fetch` calls through the egress proxy, the runtime uses `NODE_OPTIONS=--require /opt/octopus-boot/bootstrap.cjs`. That script synchronously assigns a vendored undici `ProxyAgent` to the shared global dispatcher symbol (`Symbol.for('undici.globalDispatcher.1')`), so every `fetch` in the skill process uses the proxy at `http://egress-proxy:8080`. `proxyTunnel: false` keeps plain HTTP on an absolute-form forward request (the proxy's only HTTP path) while HTTPS still opens a `CONNECT` tunnel into the MITM path.

The boot path `/opt/octopus-boot/` is mounted read-only and owned by `root` (directory mode `0555`, files mode `0444`). The runtime uid (`65534`) can read the bootstrap but cannot modify it, so a skill cannot tamper with the proxy routing.

Routing through the proxy does not bypass policy. The proxy still applies the `requested ∩ granted` allowlist, and an ungranted host returns `403 host not granted`. Fail-closed semantics are preserved.

For a skill to reach an external host, the SKILL.md must declare both:

1. The host in `sandbox.hosts`.
2. A matching entry in `sandbox.grants`.

Both declarations are required; routing to the proxy alone is not enough.

## Response-cap failure semantics

When a skill response exceeds the configured body cap, the proxy truncates and the run is reported as degraded (the cap is a hard limit, not advisory). Framing errors and protocol violations from the upstream are rejected before reaching the skill; the skill never observes a partially-framed response. Max-connection accounting refuses connections over the configured budget rather than queueing them indefinitely.

## Upstream TLS trust

Upstream TLS uses the **system trust store only** — a skill cannot install a custom root CA to MITM its own upstream. The session MITM CA (`SessionCa`) is test/development-only: it is injected by the launcher so the egress proxy can inspect and enforce the allowlist on TLS traffic, and its private key lives only in launcher memory for the duration of one execution. It is never written to disk, never mounted, and never included in the bundle the skill sees. A persisted CA key on disk, in the snapshot, in env vars, or in logs is a defect.

## Persistent MCP transport

A persistent MCP session uses `SandboxMcpTransport` bound via `SandboxRunner.bind()` over a real backend launcher (Docker or Linux). Multi-message exchanges are framed correctly; a malformed upstream response is rejected rather than crashing the transport; and closing the session reaps the underlying process and its network topology on both Docker and Linux. The Docker variant is hosted-Docker-owned; a future Linux variant must parameterize the real Linux launcher and prove the Linux path before ownership changes.

## Resource / timeout cleanup

Every run applies cleanup AFTER capturing the backend result and BEFORE returning: `backend.cleanup()` → `proxyHandle.close()` → `rm(sessionDir)`. A containment teardown failure (`ContainmentCleanupError`) downgrades `meta.isolationLevel` to `'none'`, marks `degraded: true`, and forces `success: false` — even if the child exited cleanly, because the isolation boundary may not have been fully torn down. Soft teardown failures (proxy close, session-dir removal) append to `degradationReasons` without downgrading the level. Timeout reaps the entire process tree, not just the leaf child.

## VM backend TCB production

The libkrun VM backend (`@agentoctopus/sandbox-vm-native`) ships a trusted computing base (TCB) produced on the Linux release lane by three producer scripts. The artifacts are digest-pinned and verified at launch time by `verifyVmTcb()` and the gate manifest.

**rootfs** (`scripts/build-vm-rootfs.mjs`) — the sealed read-only ext4 image the guest boots from (`vda`). Contains a pinned Linux `node`, the guest bootstrap `octopus-vm-init` (PID 1, Task 12), declared runtime bins, and the vsock→loopback forwarder. The official node build is dynamically linked, so the rootfs also bundles its ELF interpreter (at the exact loader path baked into the binary — `/lib/ld-linux-aarch64.so.1` or `/lib64/ld-linux-x86-64.so.2`) plus the transitive `DT_NEEDED` library closure (libc/libm/libstdc++/libgcc_s) in `/lib`; the set is discovered from the node binary with `readelf` and copied from the per-guest-arch library dirs CI provides (`OCTOPUS_ROOTFS_LIBS` / `OCTOPUS_ROOTFS_LIBS_ARM64`) — a dynamic node with no library dir fails the build rather than shipping a loaderless rootfs the guest cannot exec. The guest bootstrap and forwarder remain statically linked (TCB-critical, independent of the node library set). Built with **standard `mke2fs` (e2fsprogs)**, NOT the hand-written C ext4 writer — the C `vm-image-builder` is scoped to small skill block images only (single block group, ~8 MiB total / ~12 KiB per file). Reproducibility is enforced by a fixed UUID, fixed capacity algorithm, fixed inode count, disabled journal (`^has_journal`) and lazy init, `E2FSPROGS_FAKE_TIME=1` (plus a post-build `debugfs` ctime pin) for deterministic timestamps, and a **double-build SHA-256 match assertion** (CI builds the image twice and requires byte-identical digests). Produces `prebuilds/linux-arm64/rootfs.img` and `prebuilds/linux-x64/rootfs.img` (guest `node` is arch-specific). Output is sealed read-only (mode `0444`). Fail-closed on non-Linux hosts.

**libkrun + libkrunfw** (`scripts/vendor-libkrun.mjs`) — the host-side hypervisor libraries. **libkrun v1.19.4 is built from pinned source** (tag commit `728df812…`, source-tar SHA-256 `e8775fab…`) because the upstream v1.19.4 release ships no downloadable binary assets. **libkrunfw v5.5.0** uses the upstream prebuilt tarballs (libkrunfw ships prebuilt artifacts at its v5.x line, unlike libkrun): darwin-arm64 `libkrunfw-prebuilt-aarch64.tgz` (SHA-256 `5bfae6ef…`), linux-x64 `libkrunfw-x86_64.tgz` (SHA-256 `c169206b…`). Both are downloaded with checksum verification (fail-closed on mismatch), the matching-platform CI lane builds the `.dylib`/`.so`, and per-artifact TCB manifests (`libkrun.manifest.json`, `libkrunfw.manifest.json`) are written. A **minimal link + runtime smoke test** compiles a tiny program against the vendored `libkrun.h` and the built libs, proving ABI compatibility. A real VM boot smoke test is run by `run-vm-gates.mjs` (Task 16).

**helper** (`scripts/build-vm-helper.mjs`) — the `sandbox-vm-helper` C subprocess (Task 11). Links against the vendored libs, ad-hoc codesigns on Darwin with hypervisor + vm.networking entitlements, and runs the `verifyVmTcb()` self-check. Run all three producers with `pnpm --filter @agentoctopus/sandbox-vm-native security:build-vm`; qualify a lane with `security:probe-vm`.

The TCB manifest (`verifyVmTcb`, `vm-helper-build.ts`) ties four artifacts together — `helper`, `libkrun`, `libkrunfw`, `imageBuilder` — each with `{sha256, size, mode}`. The gate manifest (`gate-manifest.ts`) lists `qualifiedRootfsDigests[]` and is signed with an Ed25519 release key (Task 16). The backend rejects any rootfs not in the qualified list and any TCB artifact whose digest mismatches its manifest. The release public key is compiled into `packages/sandbox/src/vm/release-key.ts` as the trust root. `sign-release-manifest.mjs` writes a detached pair — `release-manifest.json` (the raw canonical gate-manifest body the signature covers) + `release-manifest.json.sig` (base64 Ed25519) — which `verifyOuterReleaseManifest` reads at launch. A present-but-invalid signature, or a present manifest with no committed trust root (the empty placeholder), makes the VM backend fail closed (`available: false`, `releaseManifest: 'signature-invalid'`); absent release artifacts are treated as an unsigned capability probe (`releaseManifest: 'missing'`).

## Immutable image update procedure

Runtime and proxy images are referenced only by immutable digest (`repo@sha256:<64hex>` or `sha256:<64hex>`). To update an image:

1. Build the new image and compute its `sha256:<64hex>` digest (the build is reproducible; the same inputs yield the same digest).
2. Update the trusted config (`sandbox.docker.image` / `sandbox.proxy.artifact`) to the new digest.
3. The image-contract tests re-verify the new ref: no shell/curl/npm in the runtime, proxy self-contained, immutable ref format.
4. Release Preflight records the new immutable ID; Release Publish re-verifies it against the live GitHub API before publish.

Mutable tags (`:latest`, `:v1`) are rejected by the image-contract tests and never appear in trusted config.
