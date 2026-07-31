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

Post-probe TOCTOU hardening:

`probe()` is the only point that reads and verifies `gate-manifest.json`
(binding the release signature to it) and the TCB manifest (`verifyVmTcb`
returns the exact manifest it verified — there is no double-read substitution
window). On success the engine caches the verified state per instance, and
every later phase consumes only that cache:

- `resolveRootfs()` / `assertRootfsQualified()` never re-read the gate file —
  a post-probe swap with a self-consistent but unsigned gate is invisible.
- **Prepare boundary:** all four TCB artifacts (helper, libkrun, libkrunfw,
  image-builder) are re-verified (digest + symlink + mode) when
  `resolveRootfs()` runs, immediately before the image builder is consumed.
- **Launch boundary:** `start()` re-verifies helper/libkrun/libkrunfw and
  re-hashes the rootfs image against its ref and the cached gate's
  `qualifiedRootfsDigests` immediately before exec / `krun_add_disk`.
- A gate, helper, library, builder, or rootfs swapped after `probe()` fails
  closed (regression-tested). The residual hash→exec gap (microseconds)
  cannot be closed from JavaScript without fd-pinning inside the C helper;
  file permissions (0555/0444, root-owned in release installs) are the outer
  defense for that window.

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
