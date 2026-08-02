# Agent Protocol

AgentOctopus provides an OpenClaw-compatible HTTP API for agent-to-agent communication. External agents can route queries to specialized skills, maintain sessions, and receive direct LLM answers when no skill matches.

## Quick start

```bash
# Install and run
npx @agentoctopus/gateway

# Or install globally
npm install -g @agentoctopus/gateway
agentoctopus-gateway
```

## Endpoints

### POST /agent/ask

Route a query to AgentOctopus.

**Request:**

```json
{
  "query": "what is the weather in Tokyo",
  "agentId": "my-openclaw-agent",
  "sessionId": "optional-session-id",
  "metadata": {}
}
```

**Parameters:**

- `query` (required) — the user's question or request
- `agentId` (optional) — identifier for the calling agent (default: "external-agent")
- `sessionId` (optional) — continue an existing session
- `metadata` (optional) — custom metadata to attach to the session

**Response (skill matched):**

```json
{
  "success": true,
  "response": "Tokyo: ⛅️ Partly cloudy, 18°C...",
  "skill": "weather",
  "sessionId": "abc-123",
  "confidence": 0.92
}
```

**Response (no skill match):**

```json
{
  "success": true,
  "response": "2+2 equals 4",
  "skill": null,
  "sessionId": "abc-123",
  "confidence": null
}
```

### POST /agent/feedback

Submit feedback on a skill's performance.

```json
{
  "skillName": "weather",
  "positive": true,
  "comment": "Accurate and fast"
}
```

### GET /agent/health

Health check endpoint.

```json
{
  "status": "ok",
  "skills": 4
}
```

### POST /agent/sync

Sync skills from a cloud instance.

```json
{
  "cloudUrl": "https://cloud:3002",
  "force": false
}
```

### GET /agent/skills/export

Export all skills for sync (used by cloud instances).

### GET /agent/debug/last-run

Admin-only debug endpoint that returns the aggregated per-request telemetry record for the most recent (or a named) `/agent/ask` run. Backed by the gateway-side `DebugTelemetryBuffer`, which merges telemetry events emitted across the Router / Executor / SandboxRunner / terminal `/ask` into a single `RunRecord` keyed by `traceId`.

**Configuration** (`octopus.json` → `gateway.debugEndpoints`):

| Field | Default | Role |
|---|---|---|
| `enabled` | `false` | When `false`, the endpoint is compiled out — requests return `404`, not `403`. |
| `includeQuery` | `false` | When `false`, the record carries `queryHash` (sha256 of the stripped query) and `run.query` is removed from the response. When `true`, the clean query text is stored and served as `run.query`. |
| `bufferSize` | `10` | Ring-buffer capacity. When full, the oldest record by `receivedAt` is evicted. |

**Query parameters:**

- `runId` (optional) — the trace id (e.g. `oct-e2e-<uuid>`) to fetch. When omitted, returns the latest record by `receivedAt`.

**Responses:**

- `404 { success:false, error:'Not found' }` — `debugEndpoints.enabled=false`.
- `403 { success:false, error:'Admin access required' }` — caller's API key is not `tier: 'admin'`.
- `200 { success:true, run:null }` — no record matches (empty buffer or unknown `runId`).
- `200 { success:true, run }` — the aggregated `RunRecord`. `run.query` is stripped unless `includeQuery=true` (`queryHash` may remain).

**`RunRecord` shape** (layered telemetry):

```json
{
  "runId": "oct-e2e-<uuid>",
  "status": "pending | complete | failed",
  "receivedAt": 1730000000000,
  "completedAt": 1730000001234,
  "apiKeyId": "user:<userId> | key:<sha256-16>",
  "queryHash": "<sha256>",
  "routing": { "kind": "routing.completed", "intent": "...", "intentSource": "llm | original-query-fallback", "intentExtractionSucceeded": true, "candidatesConsidered": 20, "selected": "weather", "selectedRawScore": 0.81, "normalizedConfidence": 0.92, "candidates": [{ "name": "weather", "rawScore": 0.81 }], "selectionMethod": "reranker | score-fallback", "selectedCandidateRank": 0 },
  "runs": [
    {
      "executionId": "<uuid>",
      "status": "created | final",
      "sandbox": { "kind": "sandbox.completed", "phase": "created | final", "exitCode": 0, "sandboxSuccess": true, "meta": { } },
      "adapter": { "kind": "adapter.completed", "skill": "weather", "adapterSuccess": true, "outputValidated": true, "errorCode": null }
    }
  ],
  "terminal": { "kind": "request.completed | request.failed", "reason": null }
}
```

`runs[]` entries merge the `sandbox.completed` and `adapter.completed` events for one logical execution by `executionId`. A record stays `pending` until a terminal event arrives AND every `runs[]` entry is `final` (an empty `runs[]` is vacuously final, so a no-route LLM-fallback request completes immediately). Status transitions are one-directional.

**`/ask` correlation key.** Clients may embed a trace marker in the query text as `[trace: oct-e2e-<uuid>]`. The gateway extracts it with a regex before routing/execution/session, strips it from the query (the Router/Executor never see it), and threads it through `ExecutionContext.traceId`. The gateway emits exactly one terminal event (`request.completed` or `request.failed`) per traced request, covering the feedback early-return, no-route fallback, credential-missing, unsupported-runtime, success, and exception paths. `apiKeyId` is computed as `user:<userId>` when the API-key entry has a userId, otherwise `key:<sha256(rawKey).slice(0,16)>` — the raw key is never recorded.

## Programmatic usage

```ts
import { createAgentRouter } from '@agentoctopus/gateway';
import express from 'express';

const app = express();
const agentRouter = await createAgentRouter('/path/to/AgentOctopus');
app.use('/agent', agentRouter);
app.listen(3002);
```

See also: [REST API](rest-api.md) | [OpenClaw Integration](../integrations/openclaw.md) | [Deployment](../deployment/docker.md)
