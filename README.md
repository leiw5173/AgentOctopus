# AgentOctopus

> Intelligent routing layer that connects user needs to Skills — install once, works everywhere.

Users express their intent in plain language. AgentOctopus automatically selects, invokes, and returns results from the best-matching skill.

```
User: "Translate hello to French"
        │
        ▼
  AgentOctopus  ←  intent routing + rating-aware selection
        │
        ▼
  Translation Skill
        │
        ▼
  "Bonjour"
```

## Key Features

| Feature | Description |
|---|---|
| **Smart Routing** | Embedding similarity + keyword matching + LLM re-rank with rating-aware scoring |
| **Multi-Agent** | Isolate agents with separate workspaces, models, and skill registries |
| **Multi-Channel** | CLI, REST API, Slack, Discord, Telegram, WebSocket WebChat, generic Webhooks |
| **Skill Composition** | Chain skills into execution DAGs with input/output mapping |
| **Sandbox Execution** | Skills run in a fail-closed isolation backend (Docker / privileged Linux / VM / Windows restricted) — never on the host |
| **DM Security** | Pairing mode for unknown direct-message senders |
| **Self-Evolving** | Skills auto-improve based on execution signals and user feedback |

## Quick start

```bash
npm install -g agentoctopus
octopus onboard
octopus ask "what's the weather in Tokyo"
```

## Documentation

Full documentation is available at the [GitBook docs site](https://agentoctopus.gitbook.io/readme).

- [What is AgentOctopus?](https://agentoctopus.gitbook.io/readme/what-is-agentoctopus/how-it-works)
- [Quick Start](https://agentoctopus.gitbook.io/readme/quick-start)
- [Configuration](https://agentoctopus.gitbook.io/readme/quick-start/configuration)
- [Skills](https://agentoctopus.gitbook.io/readme/routing/skills) — bundled skills, adding community skills, API key setup
- [CLI Reference](docs/api-reference/cli-reference.md) — `ask`, `sync`, `update`, retry config
- [Routing](https://agentoctopus.gitbook.io/readme/routing)
- [API Reference](docs/api-reference/rest-api.md)
- [Deployment](docs/deployment/docker.md)
- [Contributing](docs/contributing/adding-skills.md)

## Sandbox execution

Every skill runs inside a sandbox backend selected at runtime. Backend selection is **fail-closed**: candidates are probed before ranking, and a backend is admitted only when its post-probe `isolationLevel` meets `minIsolationLevel`. Under the default `auto` + `minIsolationLevel:'full'` configuration, AgentOctopus never silently degrades to a weaker backend — when no `full` backend is available, execution refuses with `NoFullBackendError` rather than running untrusted code unprotected. A missing full backend is an **execution error, not a host fallback**.

**Threat model.** Skills are untrusted code. The sandbox must deny an untrusted skill the ability to read or mutate host files outside its granted snapshot, reach the network except through the controlled egress proxy, exfiltrate host credentials, or escape process cleanup. Each backend proves its own isolation via a real capability probe before it is ever admitted; no backend is trusted on configuration alone.

**Immutable identity.** A skill never executes from its live directory. The runner builds a content-addressed snapshot, records `identity = installationId + digest` (`sha256:` + 64 lowercase hex), and re-verifies the digest immediately before backend preparation. Any mutation between build and verify aborts the run with `SNAPSHOT_MISMATCH`. Runtime and proxy images are referenced only by immutable digest (`repo@sha256:<64hex>` or `sha256:<64hex>`); mutable tags are rejected.

**Requested ∩ granted capabilities.** The caller requests a capability set per execution; the backend grants only the intersection with what its isolation actually allows. No skill receives a capability it did not request, and no backend grants a capability it cannot enforce.

**Proxy-only egress.** A skill's only network path is the per-session egress proxy (`http://egress-proxy:8080`), which enforces the requested∩granted allowlist. Direct internet, cloud metadata endpoints, and loopback services are denied. Credentials are injected into the proxy for exact-match grant scopes only — they never enter the child environment, argv, or logs.

**Direct-argv runtime.** The runtime image launches the skill with a direct argv (e.g. `node /skill/invoke.js`). There is no shell, `curl`, `bash`, `npm`, or `wget` in the trusted runtime image — verified by the image-contract tests.

**Isolation levels by backend.**

| Backend | Isolation | When it is admissible |
|---|---|---|
| Docker | `full` | Only when the real Docker probe passes (container create + network + capability enforcement). |
| Privileged Linux (named netns + cgroup v2 + nftables) | `full` | Only on a provisioned self-hosted CI runner with `CAP_SYS_ADMIN` + `CAP_NET_ADMIN`; CI-owned, zero-skip. Never claimed from macOS. |
| macOS restricted (`sandbox-exec`) | `restricted` (never `full`) | Explicit opt-in only: a trusted caller must set BOTH `defaultBackend:'os'` AND `minIsolationLevel:'restricted'`. `auto` never picks it implicitly, and `minIsolationLevel:'full'` fails closed without Docker. |
| VM (libkrun) | `full` | macOS Apple Silicon + qualified Linux x64 (with `/dev/kvm`). Skills run inside a Linux guest booted from a sealed read-only ext4 rootfs; the snapshot is a read-only ext4 block image, NOT virtiofs. Implicit TSI disabled — the sole network egress is a vsock-bridged in-process egress proxy. Qualification gates (G1 host-file-unreachable, G2 network-canary-unreachable) bind a signed gate manifest at CI time. |
| Windows restricted (Job Object + LPAC + WFP allowlist) | `restricted` (never `full`) | Explicit opt-in only: a trusted caller must set BOTH `defaultBackend:'windows'` AND `minIsolationLevel:'restricted'`. `auto` never picks it implicitly, and `minIsolationLevel:'full'` fails closed without a `full` backend. Runs on a bare Windows 10/11 host — no WSL, no Docker Desktop, no Hyper-V — but requires a **one-time elevated install** of the `OctopusSandboxGate` companion service (LocalSystem, auto-start), which owns the per-session WFP egress allowlist; without the service the backend is unavailable (fail-closed, no degraded mode). Not a VM — provides resource bounding + capability/loopback-gated proxy-only egress, not kernel isolation. |

macOS is **never** described as full isolation via `sandbox-exec`: the dyld shared-cache feasibility gate proved `file-read-data` containment cannot be established on Darwin, so the restricted production backend was abandoned and a VM backend supersedes it for full isolation. Restricted use on macOS is opt-in only. The VM backend (`@agentoctopus/sandbox-vm-native`) provides `full` isolation on macOS Apple Silicon via libkrun + Hypervisor.framework.

Windows is likewise **never** described as full isolation: the `WinSandboxBackend` combines user-mode primitives (Job Object limits + `KILL_ON_JOB_CLOSE`, LPAC capability lockdown at Low Integrity Level with `ALL APPLICATION PACKAGES` opted out, and a persistent WFP allowlist scoped to the skill's package SID that permits only the loopback egress proxy). It gives honest `restricted` isolation for operator-trusted skills on hosts without WSL/Hyper-V — it does not defend against a malicious skill exploiting a Windows kernel vulnerability, and the selection gate keeps it opt-in only.

## Development

```bash
npm install -g agentoctopus
octopus onboard    # interactive setup wizard
octopus ask "translate hello to French"
octopus list       # show installed skills
octopus search "weather"    # search local skills by name, description, and tags
octopus search "weather" --run  # search and interactively pick a skill to run
octopus evolve                  # show evolution status for all skills
```

[![CI](https://github.com/leiw5173/AgentOctopus/actions/workflows/ci.yml/badge.svg)](https://github.com/leiw5173/AgentOctopus/actions/workflows/ci.yml)

From source:

```bash
pnpm install && pnpm build
pnpm test          # 883 declared tests across 9 packages (111 in the sandbox security suite)
```

### Publishing

Releases use [changesets](https://github.com/changesets/changesets) with unified fixed versioning across all packages. See [CLAUDE.md — Versioning & Publishing](CLAUDE.md#versioning--publishing) for the full process.

## License

Apache 2.0