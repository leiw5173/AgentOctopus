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

A **mixed** profile carrying several identity blocks satisfies each backend via the field relevant to that backend, so one trusted profile can serve both Linux and macOS hosts. The fail-fast guarantees a mismatched config never creates topology or starts a proxy.

## Trusted Darwin runtime identity

A trusted `runtimeProfiles` entry may declare `darwinRuntime.manifestPath` — the host path of the verified macOS Node runtime closure manifest used by the Darwin restricted OS backend. The manifest is trusted config (never skill input) and the nested object is strict: unknown fields are rejected at config parse time. On Darwin the bare `node` command maps directly to the verified executable from the closure; the guest PATH is derived from that executable's directory, never from the profile's `path` field (which only applies to Linux/Docker guests).

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

**rootfs** (`scripts/build-vm-rootfs.mjs`) — the sealed read-only ext4 image the guest boots from (`vda`). Contains a pinned Linux `node`, the guest bootstrap `octopus-vm-init` (PID 1, Task 12), declared runtime bins, and the vsock→loopback forwarder. Built with **standard `mke2fs` (e2fsprogs)**, NOT the hand-written C ext4 writer — the C `vm-image-builder` is scoped to small skill block images only (single block group, ~8 MiB total / ~12 KiB per file). Reproducibility is enforced by a fixed UUID, fixed capacity algorithm, fixed inode count, disabled journal (`^has_journal`) and lazy init, `E2FSPROGS_FAKE_TIME=0` for deterministic timestamps, and a **double-build SHA-256 match assertion** (CI builds the image twice and requires byte-identical digests). Produces `prebuilds/linux-arm64/rootfs.img` and `prebuilds/linux-x64/rootfs.img` (guest `node` is arch-specific). Output is sealed read-only (mode `0444`). Fail-closed on non-Linux hosts.

**libkrun + libkrunfw** (`scripts/vendor-libkrun.mjs`) — the host-side hypervisor libraries. **libkrun v1.19.4 is built from pinned source** (tag commit `728df812…`, source-tar SHA-256 `e8775fab…`) because the upstream v1.19.4 release ships no downloadable binary assets. **libkrunfw v5.5.0** uses the upstream prebuilt tarballs (libkrunfw ships prebuilt artifacts at its v5.x line, unlike libkrun): darwin-arm64 `libkrunfw-prebuilt-aarch64.tgz` (SHA-256 `5bfae6ef…`), linux-x64 `libkrunfw-x86_64.tgz` (SHA-256 `c169206b…`). Both are downloaded with checksum verification (fail-closed on mismatch), the matching-platform CI lane builds the `.dylib`/`.so`, and per-artifact TCB manifests (`libkrun.manifest.json`, `libkrunfw.manifest.json`) are written. A **minimal link + runtime smoke test** compiles a tiny program against the vendored `libkrun.h` and the built libs, proving ABI compatibility. A real VM boot smoke test is run by `run-vm-gates.mjs` (Task 16).

**helper** (`scripts/build-vm-helper.mjs`) — the `sandbox-vm-helper` C subprocess (Task 11). Links against the vendored libs, ad-hoc codesigns on Darwin with hypervisor + vm.networking entitlements, and runs the `verifyVmTcb()` self-check. Run all three producers with `pnpm --filter @agentoctopus/sandbox-vm-native security:build-vm`; qualify a lane with `security:probe-vm`.

The TCB manifest (`verifyVmTcb`, `vm-helper-build.ts`) ties four artifacts together — `helper`, `libkrun`, `libkrunfw`, `imageBuilder` — each with `{sha256, size, mode}`. The gate manifest (`gate-manifest.ts`) lists `qualifiedRootfsDigests[]` and is signed with an Ed25519 release key (Task 16). The backend rejects any rootfs not in the qualified list and any TCB artifact whose digest mismatches its manifest. The release public key is compiled into `packages/sandbox/src/vm/release-key.ts` as the trust root; a present-but-invalid release signature makes the VM backend fail closed (available: false), while absent release artifacts are treated as an unsigned capability probe (`releaseManifest: 'missing'`).

## Immutable image update procedure

Runtime and proxy images are referenced only by immutable digest (`repo@sha256:<64hex>` or `sha256:<64hex>`). To update an image:

1. Build the new image and compute its `sha256:<64hex>` digest (the build is reproducible; the same inputs yield the same digest).
2. Update the trusted config (`sandbox.docker.image` / `sandbox.proxy.artifact`) to the new digest.
3. The image-contract tests re-verify the new ref: no shell/curl/npm in the runtime, proxy self-contained, immutable ref format.
4. Release Preflight records the new immutable ID; Release Publish re-verifies it against the live GitHub API before publish.

Mutable tags (`:latest`, `:v1`) are rejected by the image-contract tests and never appear in trusted config.
