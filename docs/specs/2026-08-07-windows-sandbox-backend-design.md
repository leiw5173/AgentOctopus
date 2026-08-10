# Windows Sandbox Backend — Design Spec

**Date:** 2026-08-07
**Branch:** `feat/sandbox-windows` (proposed)
**Status:** Draft v2.1.1 — third design review incorporated (see *Review changes applied*)
**Isolation target:** `restricted` (explicitly NOT `full`)

> **Implementation note (post-design pivot — Option 3).** During implementation the LPAC/AppContainer
> token proved incompatible with the Node runtime: a controlled single-variable matrix established that the
> LPAC token is the **necessary trigger** of the Node launch crash (`0x80000003` / `STATUS_BREAKPOINT`).
> Run-7 identified the internal trigger point at subsystem level: every crashing LPAC arm prints
> `WSAStartup: (10107) A system call has failed.` on the child's stderr immediately before the fail-fast,
> and no non-LPAC arm does — Node dies in its Winsock initialization under the LPAC token (consistent with
> the jitless/no-WASM-trap-handler arms changing nothing: the trigger is pre-V8). A symbolizable WER dump
> was not produced (WerFault did not write one for the AppContainer crash), so the stack itself remains
> unconfirmed. The node execution path was therefore
> pivoted **off LPAC** to **Option 3 — a `CreateRestrictedToken`-hardened token** (privileges stripped,
> Administrators deny-only, Low Integrity) launched via `CreateProcessWithTokenW` (run-7 finding:
> `CreateProcessAsUserW` fails with `ERROR_PRIVILEGE_NOT_HELD`/1314 outside a service token, which alone
> carries `SeAssignPrimaryTokenPrivilege`; `CreateProcessWithTokenW` needs only `SeImpersonatePrivilege`,
> which admin tokens hold), plus the same Job Object.
> Run-8/run-9 found the restricted-token launch itself denied (`ERROR_ACCESS_DENIED`) under BOTH logon
> flags (`LOGON_WITH_PROFILE`, then `LOGON_NETCREDENTIALS_ONLY`), so the profile load is not the only
> access-checked resource; run-10 adds `CREATE_NO_WINDOW` to the production launch (leading candidate:
> the window-station/desktop access check under a Low-Integrity child token) and a `diag-launch` helper
> subcommand whose log-only battery (impersonated image/winsta/desktop probes + six launch variants)
> isolates which access check denies.
> Run-10/run-11 resolved it: the battery shows a plain duplicate and a Medium-integrity restricted token
> both launch fine, while EVERY Low-integrity arm fails AND the Low token cannot even open the host
> toolchain node.exe (`ERROR_ACCESS_DENIED` on the image probes) — a PATH-based denial (the identical
> bytes under the session temp dir open fine; the toolchain file carries no explicit label). The
> production remedy: launch node from a **session-private node.exe copy** staged into the runner's
> sessionDir (default Medium label — the Low child reads+executes it but `NO_WRITE_UP` blocks
> self-rewrite), and key the WFP APP_ID gate on that same copy path.
> Consequences relative to the design below: (a) the WFP egress allowlist is scoped by the sandbox `node.exe`
> **application ID** (`FWPM_CONDITION_ALE_APP_ID`), not the AppContainer package SID (`ALE_PACKAGE_ID`, which
> only matches AppContainer processes); (b) there is no AppContainer package grant on the staged copy — the
> restricted token reads it through its normal Low-Integrity DACL view; (c) the LPAC path is retained only as a
> diagnostic / future-compat probe, not the execution path. This is **restricted process isolation, not
> AppContainer capability isolation.** The LPAC description below is the original design; the current mechanism
> is documented in `docs/core-concepts/sandbox.md`.

## Overview

Add a native Windows sandbox backend (`WinSandboxBackend`) so AgentOctopus can execute
skills on a bare Windows 10/11 host — no WSL, no Docker Desktop, no Hyper-V. The backend
combines four user-mode Windows primitives to deliver `restricted`-level isolation:

- **Job Object** — resource limits (memory, CPU time, process count) and guaranteed
  process-tree teardown.
- **LPAC (Less-Privileged AppContainer)** — capability-based DACL isolation of files,
  registry, processes, and windows, with the `ALL APPLICATION PACKAGES` grants opted out;
  runs at Low Integrity Level. (Fixed decision — see §5.)
- **Restricted token** — further privilege reduction, layered under the LPAC token.
- **Egress proxy over loopback, behind a port-scoped WFP egress allowlist** — the skill holds
  a loopback capability but no internet/LAN capability, and a set of *persistent* WFP filters
  scoped to the skill's **package SID** permit only `TCP 127.0.0.1:<proxyPort>` and block
  everything else. The egress proxy is the *only* reachable endpoint. WFP filters are
  installed and removed by a **privileged companion service** (installed once, elevated);
  per-skill execution stays unprivileged (§4c).

The backend is **fail-closed**: on any non-Windows platform, or when the helper / trusted
runtime cannot be built or verified, or when the companion service is absent (so the WFP gate
cannot be installed), `probe()` returns `false` and `selectBackend` omits it. There is **no
unprivileged degraded mode** in v1 (see *Decisions*). On Windows the backend registers
alongside Docker/OS/VM; under the default `auto` + `minIsolationLevel:'full'` it is never
selected implicitly — it requires `defaultBackend:'windows'` + `minIsolationLevel:'restricted'`,
mirroring the existing restricted-OS opt-in contract.

## Decisions (locked for v1)

Per the second design review, these are fixed for the first version and are **not**
configurable, to avoid shipping a second, weaker network contract:

1. **Companion service model.** A one-time elevated install registers a minimal privileged
   Windows service. That service owns all WFP writes (add/remove of the per-session gate) via
   a strictly-ACL'd RPC exposing exactly two operations — *install gate* and *remove gate
   after Job confirmed dead*. It is not a general WFP write proxy.
2. **LPAC only.** No regular-AppContainer fallback. `probe()` validates the trusted Node
   runtime's registry/COM/DLL dependencies under LPAC; if LPAC is incompatible the backend
   fails closed rather than silently weakening isolation.
3. **Per-session copy only.** The snapshot + CA are staged into a per-session directory,
   re-verified, granted READ, and deleted wholesale on cleanup. No in-place ACL editing of the
   shared snapshot store.
4. **No unprivileged degraded mode.** If the WFP gate cannot be installed, the backend is
   unavailable (fail closed). A weaker "loopback-reachable" mode is deliberately deferred to a
   separate future design if real demand appears.

## Review changes applied

- **v2.1.1 (third review):**
  - **P1 — persistent flag name:** the constant is `FWPM_FILTER_FLAG_PERSISTENT` (and
    `FWPM_PROVIDER_FLAG_PERSISTENT` / `FWPM_SUBLAYER_FLAG_PERSISTENT`), not
    `FWPM_FILTER0_FLAG_PERSISTENT` — `FWPM_FILTER0` is the struct name (§4c).
  - **P1 — provider & sublayer must also be persistent:** a persistent filter cannot reference
    a shorter-lived provider/sublayer, so the whole chain is persistent; the provider sets
    `serviceName` to the auto-start service so BFE disables its filters if the service is down
    (fail-closed) (§4c).
  - **P1 — service verifies Job death itself:** *remove-gate* is enforced service-side — the
    service resolves the named Job from its recorded session lease, confirms it is dead/empty
    via `OpenJobObject`, checks the package SID + filter keys match the lease, and refuses the
    deletion otherwise (§4c).
  - **P2 — CA wording:** the CA bundle is a per-session generated artifact with content
    integrity, not a manifest-verified artifact (Acceptance #4).
- **v2.1 (second review):**
  - **P0 — wrong WFP condition field:** use `FWPM_CONDITION_ALE_PACKAGE_ID` (type `FWP_SID`)
    for the AppContainer package SID, not `FWPM_CONDITION_ALE_USER_ID` (type
    `FWP_SECURITY_DESCRIPTOR_TYPE`, the local user). Both are valid at
    `ALE_AUTH_CONNECT_V4/V6`; only the former carries the package SID (§4c).
  - **P0 — dynamic session is fail-open for a blocker:** dynamic WFP objects are auto-deleted
    when the owning process exits/crashes, which would silently restore full loopback to a
    live skill. Switch to **persistent** per-session filters owned by the companion service's
    provider; a crash can only leave a fail-closed block, never widen access (§4c).
  - **P1 — one-shot installer can't hold per-session dynamic rules:** package SID + proxy port
    are per-session, so a transient elevated process cannot manage them. The only sound shape
    is a resident companion service (Decision 1). Also note `FwpmFilterAdd0` needs
    `FWPM_ACTRL_ADD` **and** `FWPM_ACTRL_ADD_LINK` on the provider/layer/sublayer (§4c).
  - **P1 — define a full allowlist, not a single negative rule:** specify provider, sublayer,
    weights, and action-override; the rule set is an explicit allowlist (permit proxy, block
    all else incl. V6 and UDP), not "port != proxyPort → block" (§4c).
  - **P1 — cleanup error classification inverted:** a leftover *block* filter keeps
    restricting; the real containment failure is a filter vanishing while the process is
    alive, or deleting the filter before the Job is confirmed empty. Cleanup ordering and
    classification rewritten (§4c, §cleanup).
  - **P2 — internal contradictions:** resolved via the locked Decisions above (copy-only,
    LPAC-only, no degraded mode) and a single coherent `probe()`/degradation story (§2, §5).
- **v2 (first review):** added the WFP egress gate to close the loopback-any-port hole (P0);
  removed the fictitious bind-map; added the verified `windowsRuntime` supply chain; mandated
  the suspended→assign→resume Job launch; split AppContainer vs LPAC; corrected eligibility to
  `os: [windows]`; designed ACL revocation. (Superseded in part by v2.1 / v2.1.1.)

## Motivation

- Today there is **no** Windows isolation path: `OsSandboxBackend.probe()` hard-gates on
  `process.platform === 'linux'` (`os-backend.ts:357`), `fullLevel()` requires
  `platform === 'linux'` (`probe.ts:58`), and the VM native TCB only ships
  darwin-arm64 / linux-x64. Docker is the only cross-platform backend, but Docker Desktop
  for Windows itself requires WSL2 or Hyper-V.
- Result: a Windows user with neither WSL nor Hyper-V gets `NoFullBackendError` and cannot
  run any skill in a sandbox.
- Many AgentOctopus skills are operator-trusted (weather, translation, ip-lookup). These do
  not need VM-grade defense against a malicious skill; they need resource bounding and
  network egress convergence. `restricted` isolation is the honest, sufficient fit.

## Research findings that shaped the design

Verified 2026-08-07 against Microsoft Learn (WFP filtering-conditions & access-control docs,
AppContainer launch guide, Job Object docs) and Project Zero (James Forshaw,
"Understanding Network Access in Windows AppContainers").

| Primitive | Availability | Kernel driver? | Privilege | Notes |
|---|---|---|---|---|
| Job Object limits | Win7+, all SKUs, user-mode | No | None | `JOB_OBJECT_LIMIT_JOB_MEMORY`, `ActiveProcessLimit`, CPU time, `KILL_ON_JOB_CLOSE`. |
| AppContainer / LPAC | Win8+, all SKUs (incl. Home), user-mode | No | None | `STARTUPINFOEX` + `SECURITY_CAPABILITIES` + `DeriveCapabilitySidsFromName`. LPAC additionally needs `PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY` (opt-out). |
| Restricted token | Win8+, user-mode | No | None | Composes with AppContainer token. |
| **WFP transparent redirect** | Win7+ | **YES — signed callout driver** | Admin + driver signing | `FwpsRedirectHandleCreate0` etc. are kernel `fwpsk`. Requires EV/WHCP signing. **Rejected.** |
| **WFP outbound block filter (user-mode)** | Win Vista+, user-mode | **No** | **Admin** (`FWPM_ACTRL_ADD` + `FWPM_ACTRL_ADD_LINK`) | At `FWPM_LAYER_ALE_AUTH_CONNECT_V4/V6`, `FWPM_CONDITION_ALE_PACKAGE_ID` (type `FWP_SID` — the AppContainer package SID) and `FWPM_CONDITION_IP_REMOTE_PORT` / `FWPM_CONDITION_IP_REMOTE_ADDRESS` / `FWPM_CONDITION_IP_PROTOCOL` are all available. **Not** `ALE_USER_ID` (type `FWP_SECURITY_DESCRIPTOR_TYPE` — the local user). A user-mode block filter needs no callout driver. **This is the P0 fix.** |
| AppContainer loopback | Win8–11 | No | None | Loopback is blocked by default (`AppContainerLoopback` filter, recv/accept layer → connect timeout). A loopback **capability SID** (package SID first RID 2→3) grants localhost access on **all ports, not just the proxy's** — which is exactly why the WFP allowlist gate is required. Used by Chrome's network sandbox. **Undocumented — see Risks.** |
| WFP object lifetime | — | — | — | **Dynamic** objects (added in a `FWPM_SESSION_FLAG_DYNAMIC` session) are auto-deleted when the session ends *or the owning process terminates* — fail-open for a blocker. **Persistent** objects (`FWPM_FILTER_FLAG_PERSISTENT`, `FWPM_PROVIDER_FLAG_PERSISTENT`, `FWPM_SUBLAYER_FLAG_PERSISTENT`) live until explicitly deleted and survive a crash — the correct choice for a block gate. A persistent object cannot reference a shorter-lived object, so the provider/sublayer/filter chain is all persistent; the provider's `serviceName` makes BFE disable its filters if the service isn't auto-start (fail-closed). |

**Key decision 1 — no transparent redirection.** WFP transparent redirection is ruled out: it
demands a signed kernel callout driver and an enterprise signing pipeline. The *block/permit*
side of WFP is user-mode and driver-free, so we use it instead (§4c).

**Key decision 2 — capability lockdown + persistent WFP allowlist.** The skill is given a
loopback capability and no internet/LAN capability. Because the loopback capability opens
*every* localhost port (P0), the companion service installs a set of **persistent** WFP
filters scoped to the skill's package SID that permit only the proxy endpoint and block all
else. The existing egress policy engine (`egress-proxy.ts`, CA, DNS, headers) is reused
unchanged; delivery becomes explicit proxy (`NODE_OPTIONS` bootstrap) + capability lockdown +
WFP allowlist.

**Privilege model (honest):** WFP filter add/remove requires `FWPM_ACTRL_ADD` plus
`FWPM_ACTRL_ADD_LINK` on the provider/layer/sublayer — held by Administrators. This is why a
resident **privileged companion service** (installed once, elevated) performs the WFP writes;
the per-skill sandboxed execution itself is unprivileged. See Decision 1 and §4c.

## Design

### 1. New backend kind + isolation contract

`packages/sandbox/src/types.ts`:

```
BackendKind  += 'windows'        // 'docker' | 'os' | 'vm' | 'windows' | ...
```

`packages/sandbox/src/schema.ts`:

```
defaultBackend: z.enum([...existing, 'windows'])
// minIsolationLevel unchanged — 'windows' backend always reports 'restricted'
```

**Selection gate (fail-closed, opt-in):** `selectBackend` already special-cases restricted
OS backends (`backend.ts:193-200`). Extend the same rule to Windows: a `kind:'windows'`
backend reporting `restricted` is selectable **only** when
`defaultBackend === 'windows'` AND `minIsolationLevel === 'restricted'`. Under `auto`, or
with any `full` floor, it is excluded even if `probe()` succeeds. This is byte-for-byte the
existing restricted opt-in contract applied to a new kind.

### 2. `WinSandboxBackend` (new file `packages/sandbox/src/windows/win-backend.ts`)

Implements `SandboxBackend` (`backend.ts:114-135`). The heavy lifting (Job Object,
AppContainer token, WFP gate, ACL grant, spawn) is delegated to a native helper — see §4.
The TS class owns orchestration, lifecycle, and the cleanup-memoization contract.

```
kind = 'windows'
isolationLevel: IsolationLevel
  - 'restricted' after a successful probe; 'none' before probe / on failure.

probe(): Promise<boolean>
  - Platform gate FIRST: if process.platform !== 'win32' → probeError 'platform is not win32', return false.
    (Mirrors os-backend.ts:357; test DI seam overrides drive lifecycle on other platforms.)
  - Verify the full trusted supply chain, each independently manifest-verified (fail closed if any is missing/unverifiable):
    (a) the native helper exe (strict digest/size/mode, same discipline as verifyHelperArtifact);
    (b) the trusted windowsRuntime closure — Node + bootstrap.cjs + vendored undici (§4b);
    (c) the privileged companion service is present and responsive, and can install+remove a
        throwaway per-session WFP gate (§4c). Absent service → return false (NO degraded mode, Decision 4).
  - Confirm the helper can create a Job Object, derive a loopback capability SID, and launch a
    throwaway LPAC process (self-test) under the verified runtime, then tear it down. Any failure → return false.

prepareTopology(): Promise<ProxyCarrier>
  - Return { kind: 'in-process', listenHost: '127.0.0.1', reachableHost: '127.0.0.1' }.
    Identical carrier shape to the VM backend (vm-backend.ts:62-68) — no new ProxyCarrier variant.
  - The egress proxy runs as a normal host process on loopback. Reachability is enforced by
    §4c (loopback capability + persistent WFP allowlist), NOT assumed.

prepare(opts: BackendPrepareOptions): Promise<void>
  - Assert expectedSnapshotDigest matches SNAPSHOT_DIGEST_RE (format gate only; the runner's
    verifySnapshot is the byte-for-byte authority — same split as every backend).
  - Stage a per-session copy of the snapshot + CA, re-verify it against expectedSnapshotDigest,
    and grant the skill's SIDs READ on the copy (§3, Decision 3).
  - Ask the companion service to install the persistent WFP allowlist for this session's
    package SID + proxy endpoint (§4c).
  - Stash opts for spawn/run. Does NOT execute skill code.

spawn(spec): Promise<SandboxProcess>
  - Ask the helper to launch the command under the trusted windowsRuntime, inside
    Job Object + LPAC + restricted token, with proxy convergence delivered via
    NODE_OPTIONS=--require <verified bootstrap.cjs> + CA env (§4d) — NOT merely HTTP_PROXY.
  - Return a SandboxProcess whose stdin/stdout/exited are piped to the helper's stdio relay.

run(spec): Promise<BackendRunResult>
  - Implement as spawn / write-or-end stdin / await exited / close, per the interface contract.

cleanup(): Promise<void>
  - Idempotent. ORDERING MATTERS (§4c):
    1. Terminate the named Job (KILL_ON_JOB_CLOSE) and CONFIRM it is empty.
    2. Only after the Job is confirmed dead/empty, ask the companion service to delete the
       per-session WFP filters.
    3. Delete the AppContainer profile + loopback state, and delete the per-session snapshot/CA copy wholesale.
  - Error classification (corrected — see §4c):
    * Job cannot be confirmed dead → KEEP the WFP filters and throw ContainmentCleanupError
      (never delete the gate while the process may still be alive).
    * Job confirmed dead, but WFP filter deletion fails → leftover BLOCK filter; this is
      fail-closed residue / host hygiene, a SOFT degradation (log + surface), not a containment breach.
    * A WFP filter that disappears while the process is alive → CONTAINMENT failure (fail-open).
  - Memoize the FIRST outcome; rethrow the same ContainmentCleanupError on repeat calls
    (identical contract to DockerBackend.cleanup T3).
```

### 3. Snapshot & CA delivery on Windows (per-session copy)

**Correction (P1):** AppContainer does not provide a Docker-style bind-map; it shares the
host Win32 filesystem namespace, and isolation comes from token + DACL. There is also no
`<sessionDir>\skill` today — the runner's sessionDir only carries the proxy CA
(`sandbox-runner.ts`). The previous "bind-map `<sessionDir>\skill` into the AppContainer"
step is removed.

**Delivery model (Decision 3 — per-session copy only):**

1. Stage a per-session copy of the verified snapshot + CA bundle into a session directory.
2. Re-verify the copy against `expectedSnapshotDigest` before use (defends against a
   time-of-check/time-of-use mutation between the runner's verify and the copy).
3. Grant the skill's LPAC Package/Capability SIDs READ-only DACL on the copy.
4. On cleanup, delete the whole session directory — revocation is a wholesale `rmdir`, so the
   shared, persistent snapshot store's DACL is never edited and no ACE can leak onto it.

`guestSkillRoot` / `guestCaBundlePath` for the Windows backend are the **staged-copy paths**,
not the shared store paths.

`BackendPrepareOptions.guestSkillRoot` / `guestCaBundlePath` become **per-backend
interpreted strings** (no longer the `/skill` / `/etc/skill-ca/ca.pem` literals). The runner
computes canonical values per backend kind: docker/linux/vm keep the Linux literals
(unchanged); windows gets the staged-copy paths above. Each backend keeps asserting its own
canonical values, so the digest + path contract stays fail-closed — just no longer hard-coded
to Linux strings at the type level.

### 4. Native helper + trusted runtime + network gate

Node has no API for Job Objects, AppContainer tokens, DACL manipulation, or WFP — all require
Win32. The design uses a small C/C++ helper executable (matching the `os-helper`/`vm-helper`
verified-artifact pattern) for the unprivileged per-skill work, plus a **privileged** path for
the WFP gate (§4c).

#### 4a. Job Object launch & teardown (P1 — lifecycle closed)

The helper `run` subcommand follows the race-free launch order mandated by the
`AssignProcessToJobObject` documentation (a process not yet in the Job escapes its limits,
and pre-assignment memory is not accounted):

1. `CreateProcess(..., CREATE_SUSPENDED, ...)` — child starts frozen, before any user code runs.
2. Create/open the **named** Job Object and `SetInformationJobObject` (memory/CPU/process
   limits + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`).
3. `AssignProcessToJobObject(job, child)` — assign while still suspended.
4. Only on success, `ResumeThread(child)` — now the child runs, fully inside the Job.

**Cross-process cleanup:** the Job is created with a **unique name**; teardown uses
`OpenJobObject` by name, so a separate `teardown` invocation (or a fresh helper after a TS
crash) can terminate the Job without holding the original handle. The Job handle is opened
**non-inheritable** (`SECURITY_ATTRIBUTES.bInheritHandle = FALSE`) so the untrusted child
cannot hold or re-open it. Where possible the long-lived `run` helper keeps the handle and is
terminated by the TS side; the named-Job path is the crash-safe fallback.

#### 4b. Trusted Windows runtime (P1 — supply chain)

`ResolvedRuntimeProfile` gains a `windowsRuntime` block (alongside `dockerImage`,
`osRuntime`, `darwinRuntime`, `vmRuntime` in `backend.ts:6-30`):

```
windowsRuntime?: {
  manifestPath: string   // manifest-verified closure: Node exe + bootstrap.cjs + vendored undici
  nodePath: string       // trusted absolute path to the verified Node
  bootstrapPath: string  // trusted absolute path to bootstrap.cjs
}
```

The manifest is verified with the same strict digest/size/mode discipline as the Darwin
runtime manifest (`verifyDarwinRuntimeManifest`). The runner's
`assertRuntimeProfileMatchesBackend` (`sandbox-runner.ts:431-458`) gains a `windows` branch:
a `kind:'windows'` backend **requires** `windowsRuntime` and rejects dockerImage/osRuntime/
darwinRuntime-only profiles — fail-fast before any topology or proxy launch.

#### 4c. Network egress gate (P0 — corrected boundary, persistent allowlist)

Two layers combine to make the proxy the only reachable endpoint:

1. **Capability lockdown (unprivileged, per-launch):** the LPAC token carries **only** the
   loopback capability SID (package SID first RID 2→3). It is **not** granted `internetClient`,
   `internetClientServer`, or `privateNetworkClientServer`, so direct internet/LAN is denied at
   the ALE layer.
2. **Persistent WFP allowlist (privileged, per-session):** because the loopback capability
   opens *every* localhost port, the companion service installs a small set of **persistent**
   WFP filters that permit only the proxy endpoint and block everything else for this skill's
   package SID.

**Correct condition field (P0):** scope filters by `FWPM_CONDITION_ALE_PACKAGE_ID` (data type
`FWP_SID` — the AppContainer package SID), **not** `FWPM_CONDITION_ALE_USER_ID` (data type
`FWP_SECURITY_DESCRIPTOR_TYPE` — the local user). Both are available at
`FWPM_LAYER_ALE_AUTH_CONNECT_V4/V6`; only `ALE_PACKAGE_ID` matches the package SID.

**Full allowlist rule set (P1 — not a single negative rule).** WFP's outcome is decided by
sublayer/weight arbitration, so the provider, sublayer, weights, and actions are all
specified. The companion service owns a private **provider** and a private **sublayer** at the
`ALE_AUTH_CONNECT` layers, and per session installs:

| # | Layer | Conditions | Action | Weight |
|---|---|---|---|---|
| 1 | `ALE_AUTH_CONNECT_V4` | `ALE_PACKAGE_ID == <pkgSid>` AND `IP_PROTOCOL == TCP` AND `IP_REMOTE_ADDRESS == 127.0.0.1` AND `IP_REMOTE_PORT == <proxyPort>` | **PERMIT** | high |
| 2 | `ALE_AUTH_CONNECT_V4` | `ALE_PACKAGE_ID == <pkgSid>` | **BLOCK** (all other V4 for this SID) | low |
| 3 | `ALE_AUTH_CONNECT_V6` | `ALE_PACKAGE_ID == <pkgSid>` AND `IP_PROTOCOL == TCP` AND `IP_REMOTE_ADDRESS == ::1` AND `IP_REMOTE_PORT == <proxyPort>` | **PERMIT** — only if the proxy actually listens on `::1`; otherwise omit | high |
| 4 | `ALE_AUTH_CONNECT_V6` | `ALE_PACKAGE_ID == <pkgSid>` | **BLOCK** (all other V6; if rule 3 omitted this blocks all V6) | low |

UDP is blocked outright (rules 2/4 carry no UDP permit) because the HTTP egress proxy does not
carry UDP. Filters live in the service's own sublayer with explicit weights so arbitration is
deterministic and independent of other providers' sublayers.

**Persistent, not dynamic (P0 — fail-closed on crash).** Dynamic objects
(`FWPM_SESSION_FLAG_DYNAMIC`) are auto-deleted when the owning session ends *or the process
terminates* — for a *blocker* that is fail-open (a crash would silently restore full loopback
to a live skill). So the gate uses **persistent** objects throughout. WFP forbids an object
from referencing a shorter-lived object, so the **whole chain** is created persistent at
install time:

- **provider** — `FwpmProviderAdd0` with `FWPM_PROVIDER_FLAG_PERSISTENT`, and
  `FWPM_PROVIDER0.serviceName` set to the auto-start companion service. Setting `serviceName`
  makes BFE *disable* the provider's filters if the service is absent / not auto-start — a
  fail-closed property (a stopped service never leaves an over-broad gate).
- **sublayer** — `FwpmSubLayerAdd0` with `FWPM_SUBLAYER_FLAG_PERSISTENT`, owned by that provider.
- **filters** — `FwpmFilterAdd0` with `FWPM_FILTER_FLAG_PERSISTENT` (the constant is
  `FWPM_FILTER_FLAG_PERSISTENT`, not `FWPM_FILTER0_FLAG_PERSISTENT` — `FWPM_FILTER0` is the
  struct name and does not appear in the flag), referencing the persistent provider + sublayer.

A service crash can then only leave a fail-closed block (residual DoS), never widened access.
The service sweeps stale filters for dead sessions on restart.

**Privilege & companion service (P1 / Decision 1).** `FwpmFilterAdd0` requires
`FWPM_ACTRL_ADD` on the filter container **and** `FWPM_ACTRL_ADD_LINK` on the provider, layer,
and sublayer — held by Administrators. Because the package SID and proxy port are per-session,
a transient one-shot elevated process cannot hold these rules; the only sound shape is a
**resident privileged companion service** (installed once, elevated). It exposes a
strictly-ACL'd RPC with exactly two operations — *install gate* and *remove gate* — and is not
a general WFP write proxy. If the service is absent or the gate cannot be installed/verified,
`probe()`/`prepare()` fails closed (no degraded mode, Decision 4).

**Service-side verification on remove (P1 — do not trust the caller).** *Remove gate* is a
security invariant enforced **by the service**, not merely an operation name. On a remove
request the service itself must:

1. Look up the registered **session lease** for the claimed session and resolve its named Job.
2. `OpenJobObject` by name and confirm the Job no longer exists or has **zero** active
   processes (it does not rely on the helper's say-so).
3. Verify the request's package SID and filter keys **match** the lease's recorded values.
4. Refuse to delete the allowlist if any check fails — the gate stays (fail-closed).

The lease is created at *install gate* time (recording package SID, proxy endpoint, filter
keys, and the named Job) so the service has an independent record to check against.

**Result:** internet, LAN, UDP, IPv6, and every host loopback port except the proxy are denied
for this package SID. A skill that ignores the proxy has no network at all — fail-closed by
capability + WFP allowlist, the desired property.

#### 4d. Proxy convergence delivery (P1)

Setting `HTTP_PROXY` alone does NOT make Node 22's built-in `fetch` use a proxy. Like the
existing backends, convergence is delivered through
`NODE_OPTIONS=--require <verified bootstrap.cjs>` (see `images/runtime/bootstrap.cjs`), which
the trusted `windowsRuntime` supplies. The helper injects:

- `NODE_OPTIONS=--require <bootstrapPath>` (verified, trusted absolute path),
- the CA bundle env (`caBundlePath`),
- `HTTP_PROXY`/`HTTPS_PROXY` = `http://127.0.0.1:<proxyPort>`, `NO_PROXY` empty.

Tests must assert real proxy convergence for `fetch`, `http`, and `https` — not just that the
env var is present.

**Helper / service operations (summary):**

| Operation | Runs as | Win32 / WFP APIs | Purpose |
|---|---|---|---|
| helper `probe` | unprivileged | `CreateJobObject`, `DeriveCapabilitySidsFromName`, `CreateAppContainerProfile`; RPC to service to verify gate install/remove | Self-test primitives + runtime + gate; clean up. |
| helper `grant-acl` | unprivileged | `SetNamedSecurityInfo` | READ grant on the per-session snapshot/CA copy. |
| helper `run` | unprivileged | §4a launch sequence + stdio relay | Launch sandboxed skill under trusted runtime; exit with child code. |
| helper `teardown` | unprivileged | `OpenJobObject` (by name), `TerminateJobObject`, confirm-empty, `DeleteAppContainerProfile`, delete copy | Kill tree; confirm Job empty; delete profile + copy. |
| service `install-gate` | **admin (service)** | `FwpmEngineOpen0`, `FwpmProviderAdd0`/`FwpmSubLayerAdd0`/`FwpmFilterAdd0` (all `*_FLAG_PERSISTENT`) at V4/V6, provider+sublayer+weights; record session lease | Install the per-session allowlist (rules 1–4). |
| service `remove-gate` | **admin (service)** | Verify lease + confirm named Job dead/empty itself, then `FwpmFilterDeleteByKey0`; sweep stale filters on restart | Remove the session's filters only after the service independently confirms the Job is dead. |

### 5. LPAC — fixed choice (P1 / Decision 2)

`PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` alone creates a **regular** AppContainer.
**LPAC** additionally requires `PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY` set to
opt out of the `ALL APPLICATION PACKAGES` grants; without it the process can still reach
system resources open to all AppContainers. These are distinct modes, not interchangeable.

**Decision (locked): LPAC only, no regular-AppContainer fallback.** LPAC gives the stronger
file/registry/COM isolation that matches the `restricted` claim. `probe()` validates the
trusted Windows Node runtime's actual dependencies (registry reads, COM, DLL/runtime file
loads) under LPAC by launching the verified Node and exercising them; if LPAC proves
incompatible the backend **fails closed** — it does not silently drop to a regular
AppContainer. The actual token type (LPAC) and exact capability list are asserted in CI (§6).

### 6. Skill compatibility gating (P2 — corrected)

`shouldIncludeSkill()` gates on **declared** `os` / `requires` only — it does not analyze
script contents, and `always: true` bypasses the OS/bin checks entirely
(`packages/skills/src/config.ts:46`). Corrections to v1:

- The router passes the platform string **`windows`** (not `win32`), and eligibility does an
  exact string comparison — so SKILL.md must declare `os: [windows]`. Author guidance must
  use `windows`.
- A POSIX-assuming script is excluded **only if** the skill declares a restrictive `os` list
  or `requires.bins` that Windows lacks; the backend does not inspect `/proc`-style usage.
  Skills that omit `os` are eligible on Windows and must actually work there.
- Skills that run via `scripts/invoke.js` under Node are cross-platform, provided they honor
  the proxy convergence (§4d) and do not assume POSIX-only tools.

### 7. CI

A new `windows-restricted` lane on `windows-latest` (hosted). The WFP gate install requires
elevation, so the lane runs the companion-service install step with the runner's available
elevation (hosted `windows-latest` runners provide an admin context); the sandboxed skill
execution itself is unprivileged:

- Builds the helper + runtime via `scripts/build-win-helper.mjs` and verifies all artifacts
  (helper, windowsRuntime, bootstrap, undici) independently.
- Installs the companion service, then runs the WinSandboxBackend behavioral suite (see
  *Acceptance criteria* below).
- Never claims `full`; the lane asserts the backend reports exactly `restricted`.
- Asserts the actual token type is LPAC and the exact capability list matches the configured
  expectation (§5).
- Asserts the installed WFP rule set matches the allowlist in §4c (provider, sublayer,
  weights, V4/V6, TCP-only, single permitted endpoint).
- Fork PRs: the user-mode portions run; whether the elevated service-install step is available
  to forks is a CI-runner trust question flagged for the plan phase.

## Files changed (planned)

| File | Change |
|---|---|
| `packages/sandbox/src/types.ts` | Add `'windows'` to `BackendKind` |
| `packages/sandbox/src/schema.ts` | Add `'windows'` to `defaultBackend` enum |
| `packages/sandbox/src/backend.ts` | Add `windowsRuntime` to `ResolvedRuntimeProfile`; `BackendPrepareOptions` guest-path fields → per-backend; extend restricted opt-in gate to `'windows'` |
| `packages/core/src/sandbox-runner.ts` | Add `windows` branch to `assertRuntimeProfileMatchesBackend` (requires `windowsRuntime`); compute Windows staged-copy guest paths (§3) |
| `packages/sandbox/src/windows/win-backend.ts` | **New** — `WinSandboxBackend` |
| `packages/sandbox/src/windows/runtime-manifest.ts` | **New** — verified `windowsRuntime` closure (Node + bootstrap + undici), mirroring `verifyDarwinRuntimeManifest` |
| `packages/sandbox/src/windows/helper/` | **New** — C/C++ unprivileged helper (probe / grant-acl / run / teardown) |
| `packages/sandbox/src/windows/service/` | **New** — privileged companion service (install-gate / remove-gate, persistent WFP filters, strict RPC ACL) + one-time elevated installer |
| `packages/sandbox/scripts/build-win-helper.mjs` | **New** — helper + service + runtime build, manifest emit |
| `packages/sandbox/src/windows/{acl,loopback-sid,job,gate-client}.ts` | **New** — TS wrappers over helper subcommands + the service RPC client |
| `packages/core/src/sandbox-runner-factory.ts` | Register `WinSandboxBackend` in both sync + async runner builders |
| `packages/sandbox/tests/windows/` | **New** — behavioral + fail-closed suite (see Acceptance criteria) |
| `docker-backend.ts`, `os-backend.ts`, `vm-backend.ts` | Move shared `/skill` literal assertion into per-backend canonical check |
| `.github/workflows/sandbox-security.yml` | Add `windows-restricted` lane to the fail-closed gate |

## Security properties (explicit scope)

**Provided (v1 has no degraded mode — these hold whenever the backend is selected):**

- Resource bounding (memory, CPU time, process count) via Job Object.
- File/registry/process/window isolation via LPAC DACL + Low Integrity Level, with
  `ALL APPLICATION PACKAGES` opted out.
- **Network egress convergence:** direct internet/LAN denied by withheld capabilities; every
  other endpoint — including all host loopback ports except the proxy, all UDP, and (unless the
  proxy listens on `::1`) all IPv6 — denied by the persistent WFP allowlist; the egress proxy
  is the only reachable endpoint; existing policy engine (CA, DNS, headers, secrets) reused.
- Race-free process launch (suspended → assign → resume) and guaranteed process-tree teardown
  via named Job + `KILL_ON_JOB_CLOSE`.
- Fail-closed selection, cleanup-memoization, and a WFP gate that fails **closed** on crash
  (persistent filters) and is never removed before the Job is confirmed dead.

**Availability precondition (honest):** the backend is available only when the companion
service is installed (a one-time elevated step). Without it there is no Windows sandbox —
`selectBackend` omits the backend and the run fail-closes per `minIsolationLevel`. There is no
unprivileged "loopback-reachable" fallback in v1 (Decision 4).

**Explicitly NOT provided (honest `restricted` scope):**

- No kernel-memory or side-channel isolation (not a VM).
- No defense against a malicious skill exploiting a Windows kernel vulnerability.
- No `full` isolation claim, ever, on Windows — the lane asserts `restricted` and the
  selection gate keeps it opt-in only.

## Acceptance criteria (review-mandated)

1. A malicious skill connecting to any host loopback port other than the proxy **fails**
   (persistent WFP allowlist). V1 has no degraded mode: if the gate cannot be installed the
   backend is unavailable rather than widening access.
2. The child is inside the target Job **before** `ResumeThread` (asserted via the suspended →
   assign → resume order).
3. After the helper is force-killed, after a TS crash, after a service crash, and after
   repeated `cleanup()`: the Job, AppContainer profile, loopback state, WFP filter(s), and the
   per-session copy are all auditable and correctly resolved — Job terminated and confirmed
   empty before filter removal; a service crash leaves only fail-closed residual filters that
   a restart sweep reclaims.
4. The Windows runtime (Node, bootstrap, vendored undici), the helper, and the companion
   service each pass **independent** manifest (digest/size/mode) verification before use. The
   CA bundle is **not** a manifest artifact — it is generated per-session (the session CA
   produced at proxy launch) and checked for content integrity as part of the staged,
   re-verified copy in §3.
5. Network tests cover IPv4 **and** IPv6, TCP **and** UDP, across internet, LAN, and host
   loopback non-proxy ports — asserting only the proxy endpoint succeeds.
6. CI asserts the real token type is LPAC and the exact capability list matches the configured
   expectation.
7. Proxy convergence is asserted for `fetch`, `http`, and `https` via the verified bootstrap,
   not merely the presence of `HTTP_PROXY`.
8. CI asserts the installed WFP rule set is exactly the §4c allowlist (provider, sublayer,
   weights, V4/V6 layers, TCP-only, single permitted endpoint), that provider/sublayer/filters
   are all persistent, and that the provider's `serviceName` points at the auto-start companion
   service.
9. The companion service refuses `remove-gate` when the named Job still has live processes or
   the request's package SID / filter keys do not match the recorded session lease (the check
   is enforced service-side, not by trusting the caller).

## Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| WFP gate needs a **privileged companion service** | Adds an installed, always-on privileged component; a buggy service widens host attack surface | Strictly-ACL'd RPC with exactly two operations (install / remove-after-dead); not a general WFP proxy; manifest-verified service binary; fail-closed if absent (§4c, Decision 1). |
| Wrong WFP condition field silently mismatches | Filter never matches the skill's traffic → silent over- or under-blocking | Use `ALE_PACKAGE_ID` (`FWP_SID`); CI asserts the installed rule set and that a live skill is actually blocked from non-proxy loopback (§4c, Acceptance 1/8). |
| Dynamic session would be **fail-open** for a blocker | A holder crash would restore full loopback to a live skill | Persistent filters owned by the service provider; crash leaves only fail-closed residue; restart sweep reclaims stale filters (§4c). |
| Companion service crash / stale filters | Leftover block filters = residual DoS; must never become over-broad permits | Filters are persistent + block-by-default; remove only after Job confirmed dead; startup sweep deletes filters for dead sessions (§4c, §cleanup). |
| Loopback capability SID (RID 2→3) is **undocumented** | Microsoft could change behavior; loopback grant could silently widen or break | Probe-gated: verify loopback-to-proxy at runtime, fail closed if not; pin + test per Windows build in CI; the WFP allowlist bounds even a widened loopback grant. |
| LPAC breaks the Node runtime (registry/COM/DLL deps) | Trusted runtime won't start under LPAC | `probe()` validates LPAC against the real runtime deps; **fail closed** if incompatible (no fallback, Decision 2); CI asserts LPAC token + capability list. |
| `BackendPrepareOptions` guest-path relaxation weakens a shared invariant | A backend could accept a wrong mount path | Each backend asserts its own canonical paths; digest format gate stays shared; update all backend tests. |
| Helper / runtime / service build reproducibility & trust | A tampered binary breaks isolation | Independent strict manifest verify (sha256/size/mode) for every artifact at probe; pinned build script; fail closed if unverifiable. |
| Skill bypasses proxy bootstrap and uses a raw socket | No network at all (capability + WFP denied) | Desired fail-closed outcome. Document that skills must go through the provided runtime/bootstrap. |

## Open questions for the plan phase

1. **Companion service IPC + hosting** — concrete RPC transport (ALPC vs named pipe vs RPC
   over LRPC), the exact ACL on the endpoint, service account (LocalSystem vs a virtual
   service account with only WFP rights), and the installer mechanism (MSI vs `sc.exe` +
   elevated first-run). The two-operation contract is fixed; the transport/hosting is open.
2. **Helper exe vs in-proc N-API addon** — this spec assumes a standalone exe (consistency
   with os/vm helpers, clean artifact verification). Confirm before plan.
3. **Per-package loopback exemption vs generic loopback capability SID** — capability SID is
   cleaner (one SID, no per-package CheckNetIsolation state) but undocumented; decide the
   primary + fallback order.
4. **Windows Server / LTSC SKU coverage** — AppContainer/LPAC + Job Objects are present, but
   CI on `windows-latest` covers one SKU; the service-install elevation story may differ on
   Server. Decide whether to add a Server lane.
5. **stdio relay fidelity** — the helper must faithfully proxy stdin/stdout/exit-code for
   `spawn()` (persistent sessions) and `run()`; buffering semantics need to match
   `SubprocessAdapter` expectations.

## Docs to update (when implemented)

| Doc | Change |
|---|---|
| `README.md` | Add Windows to the sandbox platform matrix |
| `CLAUDE.md` | Architecture §sandbox: add `windows` backend + `'windows'` config enum + Windows lane |
| `TEST_INSTRUCTIONS.md` | Windows backend test rows |
| `docs/core-concepts/sandbox.md` | Windows restricted backend section |
| `docs/deployment/security.md` | Windows isolation scope + honest `restricted` caveats |
| `implementation_plan.md` | New phase row for the Windows backend |
