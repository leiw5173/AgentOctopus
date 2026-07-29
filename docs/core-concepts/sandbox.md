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

## Env hygiene

The guest environment is a minimal allowlist (`LANG`, `LC_ALL`, `TZ`) plus non-reserved caller keys and fixed guest values (`HOME=/tmp/home`, `TMPDIR=/tmp`, runtime-profile `PATH`). Host `process.env` is never spread into the sandbox, and credentials never enter child env, argv, or logs — only the trusted egress proxy receives grant-scoped credential values.
