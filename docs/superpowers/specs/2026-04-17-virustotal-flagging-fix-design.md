# Design: Eliminate VirusTotal Code Insight Flagging for agentoctopus-openclaw

**Date:** 2026-04-17
**Status:** Draft

## Problem

When users install `agentoctopus-openclaw` via `clawhub update`, VirusTotal Code Insight flags it as "Suspicious — high confidence" with this detail:

> The skill mostly does what it says (runs an AgentOctopus CLI to route tasks) but it runs third-party CLI code (via npx fallback), inherits the full process environment, and the README/install instructions don't warn about those risks — these gaps could expose secrets or execute remote code unexpectedly.

Static analysis: 1 pattern detected at `scripts/invoke.js:20` — Shell command execution detected (`child_process`).

This warning scares users away from installing the skill.

## Root Cause

The `invoke.js` script uses `execFileSync` from `child_process` to run the `octopus` CLI (or `npx` as fallback) and passes the full `process.env` to the child process. These are the three triggers:

1. **`child_process` import** — the only hard static-analysis flag
2. **`npx --yes` fallback** — downloads and executes remote code
3. **`process.env` passthrough** — exposes all environment secrets to child process

## Solution

Replace `child_process` with `fetch()` to the local AgentOctopus gateway. The weather skill already uses `fetch()` and passes VirusTotal cleanly.

### New flow

```
OpenClaw → invoke.js → fetch('localhost:PORT/agent/ask') → Gateway → Router → Executor → Result
```

### Components

#### 1. Rewrite `invoke.js` — `fetch()` instead of `child_process`

- Parse `OCTOPUS_INPUT` env var (same as current)
- Read gateway port from `OCTOPUS_GATEWAY_PORT` env var (default `3002`)
- Check gateway health via `GET /agent/health` first; if unreachable, return a helpful error message
- Call `POST /agent/ask` with `{ query }` body
- Return `{ result }` from the response JSON
- No `child_process`, no `npx`, no `process.env` passthrough
- No new dependencies — `fetch()` is built into Node 18+

#### 2. Skip auth for localhost requests in gateway

The gateway currently requires an API key for `/agent/ask`. For the OpenClaw skill calling from the same machine, this is unnecessary friction.

- In `authMiddleware`, check if `req.ip` is `127.0.0.1`, `::1`, or `::ffff:127.0.0.1`
- If localhost, skip auth and attach a synthetic `apiKeyEntry` with tier `admin` (no rate limits for local)
- This only applies when `AUTH_ENABLED !== 'false'` (auth is on); when auth is already off, no change needed
- Controlled by env var `LOCALHOST_AUTH_BYPASS` (default `true`) so it can be disabled for deployments where the gateway is exposed to a network. Default `true` is safe because the gateway binds to `localhost` only and the skill runs on the same machine.

#### 3. Add `octopus start --daemon` flag

Start the gateway as a background daemon so OpenClaw users don't need a separate terminal.

- `octopus start --daemon` — starts gateway in background, writes PID to `~/.agentoctopus/gateway.pid`
- `octopus start --stop` — stops the daemon via the PID file
- `octopus start --status` — checks if daemon is running and prints port
- If gateway is already running (PID file exists and process is alive), print a message and exit
- Port written to `~/.agentoctopus/gateway.port` so other tools can discover it

#### 4. Enhance `octopus connect openclaw` — auto-start daemon

After saving the OpenClaw config, automatically start the gateway daemon.

- Check if gateway is already running via health check on default port
- If not running, start it with `--daemon`
- Print the gateway URL so the user knows it's active

#### 5. Update `SKILL.md` — reflect new setup and add security section

- Update setup instructions to mention the gateway daemon
- Add a "Security" section explaining:
  - The skill only makes HTTP requests to the local gateway
  - No shell commands are executed
  - No environment variables are passed to child processes
  - The gateway runs locally and does not expose data externally
- Remove references to `npx` fallback
- Bump version to `1.2.0`

### Port discovery

The invoke script reads the port from:

1. `OCTOPUS_GATEWAY_PORT` env var (set by OpenClaw or user)
2. `~/.agentoctopus/gateway.port` file (written by `octopus start --daemon`)
3. Fallback to `3002` (default)

### Error handling

If the gateway is not running, the invoke script returns:

```json
{ "result": "AgentOctopus gateway is not running. Start it with: octopus start --daemon" }
```

This is much better than the current behavior where a missing `octopus` binary causes a cryptic `child_process` error.

### What this eliminates

| Concern | Before | After |
|---------|--------|-------|
| `child_process` static flag | `execFileSync` at line 20 | No `child_process` import |
| Third-party code execution | `npx --yes` fallback | No `npx` at all |
| Secrets exposure | Full `process.env` passthrough | No env passthrough |
| Missing security docs | No warnings in SKILL.md | Explicit security section |

### What stays the same

- The gateway's `/agent/ask` endpoint and its behavior
- The `octopus ask` CLI command (still uses the engine directly, not the gateway)
- The `octopus connect openclaw` config extraction logic
- All other skills and adapters

### Files changed

| File | Change |
|------|--------|
| `registry/skills/agentoctopus-openclaw/scripts/invoke.js` | Rewrite: `fetch()` instead of `child_process` |
| `registry/skills/agentoctopus-openclaw/SKILL.md` | Update setup, add security section, bump version |
| `packages/gateway/src/auth-middleware.ts` | Add localhost auth bypass |
| `apps/cli/src/index.ts` | Add `--daemon`, `--stop`, `--status` flags to `start` command |
| `apps/cli/src/connect.ts` | Auto-start gateway daemon after config save |

### Out of scope

- Changing how other skills work (weather, x-search, etc.)
- Modifying the VirusTotal scanning pipeline itself
- Adding a cloud-hosted gateway option (local only for now)
