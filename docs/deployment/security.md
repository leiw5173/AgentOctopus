# Security

The agent gateway (`/agent/*` endpoints) includes built-in security for production deployment.

## API key authentication

All authenticated endpoints require an API key:

```bash
# Register for a free API key
curl -X POST https://your-gateway/agent/register \
  -H 'Content-Type: application/json' \
  -d '{"email": "you@example.com"}'
# → { "apiKey": "ak_...", "tier": "free", "limits": { ... } }

# Use the key in requests
curl -X POST https://your-gateway/agent/ask \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer ak_...' \
  -d '{"query": "translate hello to French"}'
```

Keys can also be passed via `X-API-Key` header or `?apiKey=` query parameter.

## Rate limiting

Tier-based sliding-window rate limiting with standard headers:

| Tier | Requests/min | Requests/day | Price |
|---|---|---|---|
| Free | 10 | 100 | $0/mo |
| Pro | 60 | 5,000 | $19/mo |
| Enterprise | 300 | 50,000 | $99/mo |

Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

## Audit logging

All requests are logged to `<deploy.root>/logs/audit.jsonl` (defaults to `./logs`) with:

- Timestamp, HTTP method, path, IP address
- Masked API key, user ID, tier
- Status code, response time, query content

## Configuration

Security settings are configured in `~/.agentoctopus/octopus.json` under the `auth` and `gateway` sections:

| Field | Type | Default | Description |
|---|---|---|---|
| `auth.enabled` | boolean | `true` | Enable/disable API key authentication |
| `auth.rateLimitEnabled` | boolean | `true` | Enable/disable rate limiting |
| `auth.apiKeysPath` | string \| null | `null` | Path to API keys store |
| `gateway.corsOrigins` | string[] | `["*"]` | Allowed CORS origins |

See [Configuration](../getting-started/configuration.md) for all available settings.

## Security considerations

- The gateway supports built-in authentication — deploy behind a reverse proxy for additional protection
- Skills execute in isolated processes/containers
- No user data is persisted beyond session memory (30 min TTL)
- Rate limiting is configurable per tier

## Windows sandbox companion service

The native Windows backend (`WinSandboxBackend`) relies on a **privileged companion service**, `OctopusSandboxGate`, installed once with elevation:

- Runs as a Windows service (`LocalSystem`, `SERVICE_AUTO_START`) from a build-produced exe (`octopus-sandbox-gate-svc.exe`). The build script (`build-win-helper.mjs`) writes a per-artifact manifest for the helper and service exes, but `probe()` does not re-verify those manifests at runtime — only the `windowsRuntime` closure (Node exe + `bootstrap.cjs` + vendored undici) is manifest-verified (sha256 + size) at probe time.
- Owns every write to the per-session **WFP (Windows Filtering Platform) egress allowlist** — the persistent provider/sublayer/filters that scope a sandboxed skill to `TCP 127.0.0.1:<proxyPort>` (and `TCP [::1]:<proxyPort>` when the proxy dual-binds) and block all other connects for the skill's AppContainer package SID. WFP filter add/remove requires administrator rights (`FWPM_ACTRL_ADD` + `FWPM_ACTRL_ADD_LINK`), which is why this component exists; the sandboxed skill execution itself is unprivileged.
- Exposes a strictly-ACL'd named-pipe RPC at `\\.\pipe\octopus-sandbox-gate` (DACL allows only Builtin Administrators, LocalSystem, and the interactive user) with **exactly two operations** — `install-gate` and `remove-gate`. It is not a general WFP write proxy; any other op is refused.
- **Service-side verification on remove.** On `remove-gate` the service does not trust the caller: it resolves the recorded session lease, opens the named Job Object itself, confirms the Job is dead/empty (`ActiveProcesses == 0`), verifies the request's package SID and filter keys match the lease, and refuses the deletion otherwise — the gate stays (fail-closed). A service crash can only leave a fail-closed *block* filter; the startup sweep reclaims filters whose Jobs are already dead.

**Honest scope.** The Windows backend provides **`restricted` isolation — not kernel isolation and never `full`**:

- It is **not a VM**: no kernel-memory or side-channel isolation, and no defense against a malicious skill exploiting a Windows kernel vulnerability.
- The network boundary is the WFP allowlist plus the withheld internet/LAN capabilities on the LPAC token; the filesystem/registry boundary is LPAC DACL isolation at Low Integrity Level; resource bounding and teardown come from the Job Object (`KILL_ON_JOB_CLOSE`).
- It is selectable only via the explicit opt-in `defaultBackend:'windows'` + `minIsolationLevel:'restricted'`. Under `auto`, or with a `full` floor, it is never picked — a missing full backend fails closed with `NoFullBackendError`.
- If the companion service is absent or unresponsive, `probe()` returns `false` and the backend is simply unavailable — there is no unprivileged degraded mode that would widen network access.

Operators should treat the companion service as part of the host's trusted computing base: it is privileged, always-on, and — while its exe carries a build-time manifest — that manifest is not re-verified at probe time (only the runtime closure is), so a compromised service widens the host attack surface. Install it only on hosts where Windows sandboxing is actually needed.

## VM release trust root

The native VM backend (`@agentoctopus/sandbox-vm-native`) ships a **signed
release manifest** (`release-manifest.json` + `release-manifest.json.sig`,
Ed25519) inside each platform's `prebuilds/` directory. At launch,
`engine.probe()` verifies the detached signature against the public key
compiled into `@agentoctopus/sandbox` (`packages/sandbox/src/vm/release-key.ts`)
— never fetched at runtime, never read from config, never env-overridable.

Fail-closed semantics:

- **Manifest present, signature invalid or key missing** → `probe()` returns
  `available:false` + `releaseManifest:'signature-invalid'`. The VM backend is
  unavailable rather than running on an unverified TCB.
- **Signed body does not bind to the loaded gate manifest** → after the
  signature verifies, `probe()` parses the signed body and requires
  canonical-digest (`computeManifestDigest`) equality with the
  gate-manifest.json actually loaded and verified. This closes the mixed-state
  attack: a legitimately-signed OLD release manifest cannot authorize a swapped
  gate manifest, TCB manifest, or binaries.
- **Half pair — only one of `release-manifest.json` / `.sig` present** → fail
  closed unconditionally (`signature-invalid`). The producer writes both
  atomically and pack enforces both, so a half pair means deletion or a
  half-shipped release — deleting the `.sig` never degrades a signed build to
  unsigned mode. A file deleted between the existence check and the read
  (TOCTOU) also fails closed.
- **Pair absent** → fail closed when the engine is built with
  `requireReleaseSignature` — which production assembly (core's
  `buildEngineOpts`) compiles in: a shipped native package is a release build,
  so a missing signature pair is a tampered install, and deleting both files
  cannot roll it back to dev mode. Without the flag (dev boxes, the vm-lane CI
  harness) an absent pair degrades softly to `releaseManifest:'missing'` and
  the capability probe stays up.

Verified-object binding (post-probe TOCTOU):

`probe()` is the only point that reads and verifies `gate-manifest.json`
(binding the release signature to it) and the TCB manifest (`verifyVmTcb`
returns the exact manifest it verified — there is no double-read substitution
window). It then binds the **verified object** to the **used object**, so
later phases never trust an on-disk path again:

- **Exec-path binding:** before any execution, `probe()` realpath-enforces
  that the configured helper path resolves to the `verifyVmTcb()`-verified
  helper — a divergent path fails closed and the capability probe never runs.
  The assembly likewise realpath-enforces the configured builder path against
  `artifactsDir/vm-image-builder`, and the image builder is executed at the
  engine's probe-verified path (resolved lazily after probe), never at an
  independently configured path.
- **Private verified copies:** `probe()` copies the helper, libkrun,
  libkrunfw, and image-builder into an engine-private 0700 directory, hashing
  the bytes *as they are read for the copy* from a single `O_NOFOLLOW` file
  descriptor — the copy's digest must equal the verified manifest entry. This
  happens **before** the BLK capability probe, which executes the private
  helper copy with the loader path pointed at the private directory (the
  original path is never executed — a realpath→exec swap cannot smuggle in
  unverified code). On Linux the versioned SONAME shims
  (`libkrun.so.1 → libkrun.so`, `libkrunfw.so.5 → libkrunfw.so`) are
  recreated inside the private directory pointing at the verified copies, so
  the helper's versioned `DT_NEEDED` entries resolve to the verified
  libraries rather than missing — or falling back to unverified system
  copies. Any probe failure after the copies are made discards the private
  directory. Only those copies are ever executed or loaded (`start()` execs
  the private helper with the dynamic-loader path pointed at the private
  directory), so a post-probe swap of the original files is irrelevant.
- **Pinned rootfs fd:** `resolveRootfs()` opens the rootfs image
  `O_RDONLY|O_NOFOLLOW`, hashes from that open descriptor, and keeps it
  pinned. `start()` inherits the descriptor into the helper at fd 5 and the
  launch spec references `/dev/fd/5` — the attached image is the verified
  inode even if the path is replaced after resolution. The helper's launch
  mode preserves fd 5-7 across its startup mass-close (watermark 8: the
  pinned rootfs fd 5 plus the `krun-stdio` console-port pipe fds 6/7; the
  `--has-blk` probe mode still closes everything ≥ 5) and `fcntl`-checks the
  fd before `krun_add_disk`. `engine.close()` (invoked by backend cleanup)
  releases the fd and the private directory.
- A helper, library, builder, or rootfs swapped after `probe()` is
  **neutralized** — the verified copy or pinned inode is what runs
  (regression-tested); a rootfs swapped *before* resolution still fails
  closed on the from-fd digest check.

Release infrastructure:

- CI signs with the secret `OCTOPUS_VM_RELEASE_PRIVATE_KEY` (a base64 32-byte
  Ed25519 seed; the signer wraps it into PKCS8 DER). The secret is custody-only
  — it never appears in the repository.
- Release Preflight fails closed if either platform's complete signed TCB is
  missing from the lane artifacts; the published tarball is asserted to contain
  the helper, image builder, vendored libkrun/libkrunfw, sealed rootfs, TCB +
  gate manifests, and the release-manifest signature pair.

**Key rotation:** generate a new Ed25519 keypair, replace
`RELEASE_PUBLIC_KEY_BASE64` with the new base64 DER SPKI public key, rotate
`OCTOPUS_VM_RELEASE_PRIVATE_KEY` to the new base64 seed, and ship a release.
Signatures from the old key fail closed immediately after rotation.

See also: [Docker](docker.md) | [Cloud & Local Modes](cloud-local.md) | [Configuration](../getting-started/configuration.md)
