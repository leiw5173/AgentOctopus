# Hermes

Use AgentOctopus as a skill for Hermes agents via the `octopus` CLI.

## Setup

```bash
npm install -g agentoctopus
octopus onboard       # configure your LLM provider
octopus start         # starts gateway on http://localhost:3002
```

Install the AgentOctopus skill into Hermes so it appears in the Hermes skill index:

```bash
# From Hermes: import the AgentOctopus skill
clawhub install agentoctopus
```

The skill is installed at `~/.hermes/skills/openclaw-imports/agentoctopus/SKILL.md`. Hermes invokes it through the `octopus` CLI — `octopus ask "<query>"` — which talks to the gateway. No direct HTTP wiring is needed in your Hermes agent config.

When Hermes routes a query to the AgentOctopus skill, the skill calls `octopus ask "<query>"` as a subprocess. The gateway routes the query through the skill system and returns the result to Hermes.

## End-to-end verification

Confirm the full pipeline (intent analysis → skill selection → sandboxed execution → debug record) with the `hermes-e2e-test` acceptance gate.

### Prerequisites

1. **Gateway running** with debug endpoints enabled — add to `~/.agentoctopus/octopus.json`:

   ```json
   {
     "version": 2,
     "gateway": {
       "debugEndpoints": {
         "enabled": true,
         "includeQuery": false,
         "bufferSize": 10
       }
     }
   }
   ```

   Start the gateway: `octopus start` (port 3002 by default).

2. **Two API keys** created via `createApiKey` (exported from `@agentoctopus/gateway`):

   ```bash
   # Free-tier key — used to call POST /agent/ask
   node -e "import('@agentoctopus/gateway').then(g => {
     const { key, entry } = g.createApiKey({
       email: 'e2e-ask@test.com', tier: 'free',
       userId: 'user_e2e_ask', description: 'E2E ask key'
     });
     console.log('ASK_KEY=' + key);
   })"

   # Admin-tier key — used to call GET /agent/debug/last-run
   node -e "import('@agentoctopus/gateway').then(g => {
     const { key, entry } = g.createApiKey({
       email: 'e2e-admin@test.com', tier: 'admin',
       userId: 'user_e2e_admin', description: 'E2E admin key'
     });
     console.log('ADMIN_KEY=' + key);
   })"
   ```

3. **Environment variables** set in your shell:

   ```bash
   export AGENTOCTOPUS_E2E_ASK_KEY='<free-tier key from above>'
   export AGENTOCTOPUS_E2E_ADMIN_KEY='<admin-tier key from above>'
   ```

4. **Hermes logged in** so the Hermes-driven invocation path is exercised.

### Running the test

The test skill lives at `~/.claude/skills/hermes-e2e-test/{SKILL.md,run.mjs}` — it is machine-only and not shipped in the AgentOctopus repository. Install it on your own machine before running.

```bash
node ~/.claude/skills/hermes-e2e-test/run.mjs --json
```

The test runs two independent legs:

- **Leg 1a (Hermes CLI):** drives `hermes -z "<query>"` under an octopus-wrapper that records every CLI invocation as JSONL, then asserts 4-point forensics (Stage 1).
- **Leg 1b (telemetry):** `run.mjs` itself POSTs `/agent/ask` with a `[trace: oct-e2e-<uuid>]` correlation marker (directly, for deterministic control), then polls `GET /agent/debug/last-run` until the aggregated RunRecord is fully final, then asserts stages 2–5 from routing/selection/score/sandbox+adapter telemetry.

| Stage | Name | What it checks |
|---|---|---|
| 1 | hermes+wrapper | hermes exited 0; the wrapper marker file records an `ask` invocation with matching nonce; the real octopus inside exited 0 with no signal |
| 2 | routing | Debug record shows `routing.intent` populated (the LLM-extracted intent phrase), `routing.intentSource === 'llm'`, and `routing.candidatesConsidered > 0` |
| 3 | selection | Debug record shows `routing.selected` matching the expected skill name (default `weather`) |
| 4 | score-semantics | Score-fallback path: `selectedCandidateRank === 0` and `normalizedConfidence >= threshold`; reranker path: `selected` is in `candidates[].name` |
| 5 | sandbox+adapter | The final `runs[]` element carries both a sandbox event (`meta.backend === 'docker'`, `meta.isolationLevel === 'full'`, `sandboxSuccess === true`) and an adapter event (`adapterSuccess === true`, `outputValidated === true`) |

**Expected output (all stages PASS):**

```json
{
  "correlationKey": "oct-e2e-<uuid>",
  "stages": [
    { "stage": 1, "name": "hermes+wrapper",  "pass": true, "detail": "hermes exit 0; wrapper invoked 'ask' (nonce match); real octopus exit 0, no signal" },
    { "stage": 2, "name": "routing",         "pass": true, "detail": "intent='weather tokyo', source=llm, candidates=20" },
    { "stage": 3, "name": "selection",       "pass": true, "detail": "selected='weather'" },
    { "stage": 4, "name": "score-semantics", "pass": true, "detail": "method=reranker; selected 'weather' ∈ candidates" },
    { "stage": 5, "name": "sandbox+adapter", "pass": true, "detail": "backend=docker, isolationLevel=full, sandboxSuccess=true, adapterSuccess=true, outputValidated=true" }
  ],
  "verdict": "PASS",
  "run": { "runId": "oct-e2e-...", "status": "complete", "runs": [{ "executionId": "...", "status": "final", "sandbox": {}, "adapter": {} }] }
}
```

If any stage fails, the stage has `"pass": false` and the `verdict` is `"FAIL"`. The failing stage's `detail` field explains what was expected vs. what was received.

See also: [OpenClaw](openclaw.md) | [Claude Code](claude-code.md) | [REST API](../api-reference/rest-api.md)
