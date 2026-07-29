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
