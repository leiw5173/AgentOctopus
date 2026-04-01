# AgentOctopus — Manual Test Instructions

This document covers end-to-end manual testing for all three phases.
Run tests in order — each phase builds on the previous one.

---

## Prerequisites

```bash
# From the repo root
pnpm install
pnpm build

# Confirm .env exists and has these keys set
cat .env | grep -E "EMBED_API_KEY|EMBED_BASE_URL|RERANK_MODEL"
# Expected: all three lines present and non-empty
```

---

## Phase 1 — CLI MVP

### 1.1 List available skills

```bash
cd /root/AgentOctopus
node apps/cli/dist/index.js list
```

**Expected:** Three skills printed with names, star ratings, adapter type, and invocation count:
- `translation` — 4.5 ★
- `weather` — 4.8 ★
- `ip-lookup` — 4.6 ★

---

### 1.2 Weather query

```bash
node apps/cli/dist/index.js ask "What's the weather in London?"
```

**Expected:**
- Spinner shows skill selection → `weather` selected
- Output includes temperature in °C/°F, conditions, humidity, wind speed
- Prompt: `Was this helpful? (y/n):`
- Type `y` → prints "Rating updated."

---

### 1.3 Translation query

```bash
node apps/cli/dist/index.js ask "Translate good morning to Japanese"
```

**Expected:**
- Skill selected: `translation`
- Output: `"good morning" in Japanese: おはようございます` (or similar)
- Feedback prompt → type `y`

---

### 1.4 IP lookup query

```bash
node apps/cli/dist/index.js ask "Lookup IP 1.1.1.1"
```

**Expected:**
- Skill selected: `ip-lookup`
- Output shows location (Australia), ISP (Cloudflare), timezone, coordinates
- Feedback prompt → type `n` → prints "Rating updated."

---

### 1.5 Rating persistence check

```bash
# After giving feedback above, verify ratings.json was updated
cat registry/ratings.json
```

**Expected:** JSON file with entries for the skills you gave feedback on, showing updated rating values.

---

### 1.6 Automated test suite

```bash
pnpm test
```

**Expected:** All 35 tests pass across 6 packages with no failures:
```
packages/registry  — 9 tests  ✅
packages/adapters  — 3 tests  ✅
packages/core      — 6 tests  ✅
apps/cli           — 1 test   ✅
apps/web           — 6 tests  ✅
packages/gateway   — 10 tests ✅
```

---

## Phase 2 — REST API

Start the web server first:

```bash
cd apps/web && pnpm dev
# Wait for: ✓ Ready in ...ms
```

### 2.1 POST /api/ask — weather

```bash
curl -s -X POST http://localhost:3000/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "What is the weather in Paris?"}' | jq .
```

**Expected:**
```json
{
  "success": true,
  "skill": "weather",
  "confidence": 0.9,
  "rating": 4.8,
  "response": "Weather in Paris, France:\n  Conditions : ..."
}
```

---

### 2.2 POST /api/ask — translation

```bash
curl -s -X POST http://localhost:3000/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "Translate hello world to Spanish"}' | jq .
```

**Expected:**
```json
{
  "success": true,
  "skill": "translation",
  "response": "\"hello world\" in Spanish: Hola Mundo"
}
```

---

### 2.3 POST /api/ask — IP lookup

```bash
curl -s -X POST http://localhost:3000/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "Geolocate IP address 8.8.8.8"}' | jq .
```

**Expected:**
```json
{
  "success": true,
  "skill": "ip-lookup",
  "response": "IP / Host  : 8.8.8.8\nLocation   : Ashburn, Virginia, United States\n..."
}
```

---

### 2.4 POST /api/ask — missing query (validation)

```bash
curl -s -X POST http://localhost:3000/api/ask \
  -H 'Content-Type: application/json' \
  -d '{}' | jq .
```

**Expected:** `{ "error": "Query is missing" }` with HTTP 400.

---

### 2.5 POST /api/feedback — thumbs up

```bash
curl -s -X POST http://localhost:3000/api/feedback \
  -H 'Content-Type: application/json' \
  -d '{"skillName": "weather", "positive": true}' | jq .
```

**Expected:**
```json
{ "success": true, "skillName": "weather", "newRating": <number> }
```
Rating should be slightly above the baseline (4.8).

---

### 2.6 POST /api/feedback — thumbs down

```bash
curl -s -X POST http://localhost:3000/api/feedback \
  -H 'Content-Type: application/json' \
  -d '{"skillName": "translation", "positive": false, "comment": "wrong language"}' | jq .
```

**Expected:** `{ "success": true, "skillName": "translation", "newRating": <number slightly below 4.5> }`

---

### 2.7 POST /api/feedback — unknown skill (validation)

```bash
curl -s -X POST http://localhost:3000/api/feedback \
  -H 'Content-Type: application/json' \
  -d '{"skillName": "nonexistent", "positive": true}' | jq .
```

**Expected:** `{ "error": "Skill \"nonexistent\" not found" }` with HTTP 404.

---

### 2.8 Web UI — chat interface

Open `http://localhost:3000` in a browser.

**Expected:**
- Page loads without 500 error or console errors
- Header shows "AgentOctopus" with subtitle
- Three example query pills visible:
  - "What's the weather in Tokyo?"
  - "Translate "good morning" to Japanese"
  - "Lookup IP 8.8.8.8"

**Test the example pills:**
1. Click "What's the weather in Tokyo?" → animated typing dots appear → response with weather data renders in a chat bubble
2. Skill badge shows `weather`, match %, star rating
3. Click 👍 → both buttons disable (feedback sent)
4. Click "Lookup IP 8.8.8.8" pill → response shows IP details
5. Click 👎 on that response → buttons disable

**Test manual input:**
1. Type "Translate goodbye to French" → press Enter
2. Response: `"goodbye" in French: Au revoir`
3. Shift+Enter in the textarea → inserts newline (does NOT send)

---

## Phase 3 — IM & Agent Gateway

### 3.1 Agent Protocol — standalone server

In a new terminal:

```bash
cd /root/AgentOctopus
node -e "
import('@octopus/gateway').then(g => g.startAgentGateway('/root/AgentOctopus')).catch(console.error)
"
# Wait for: [Agent Gateway] Listening on port 3002
```

---

### 3.2 GET /agent/health

```bash
curl -s http://localhost:3002/agent/health | jq .
```

**Expected:**
```json
{ "status": "ok", "skills": 3 }
```

---

### 3.3 POST /agent/ask — first turn

```bash
curl -s -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "What is the weather in Berlin?", "agentId": "test-agent"}' | jq .
```

**Expected:**
```json
{
  "success": true,
  "skill": "weather",
  "response": "Weather in Berlin...",
  "sessionId": "<uuid>",
  "confidence": <number>
}
```

Copy the `sessionId` from the response for the next test.

---

### 3.4 POST /agent/ask — session continuity

```bash
# Replace <SESSION_ID> with the value from 3.3
curl -s -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "Translate that city name to Japanese", "sessionId": "<SESSION_ID>"}' | jq .
```

**Expected:** Returns a new response with the **same `sessionId`** — confirming the session was reused, not recreated.

---

### 3.5 POST /agent/ask — missing query (validation)

```bash
curl -s -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"agentId": "test"}' | jq .
```

**Expected:** `{ "success": false, "error": "query is required" }` with HTTP 400.

---

### 3.6 POST /agent/feedback

```bash
curl -s -X POST http://localhost:3002/agent/feedback \
  -H 'Content-Type: application/json' \
  -d '{"skillName": "weather", "positive": true, "comment": "accurate result"}' | jq .
```

**Expected:** `{ "success": true }`

---

### 3.7 POST /agent/feedback — validation

```bash
curl -s -X POST http://localhost:3002/agent/feedback \
  -H 'Content-Type: application/json' \
  -d '{"skillName": "weather"}' | jq .
```

**Expected:** `{ "success": false, "error": "skillName and positive (boolean) are required" }` with HTTP 400.

---

### 3.8 Session TTL (optional)

The session manager expires sessions after 30 minutes of inactivity. To verify the logic without waiting:

```bash
pnpm --filter @octopus/gateway test
```

**Expected:** 10 tests pass, including the `prune` test that artificially ages a session and verifies it is replaced on the next `getOrCreate` call.

---

### 3.9 IM Bots (Slack / Discord / Telegram)

> These require live bot tokens. Skip if tokens are not configured.

**Slack:** Set `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN` in `.env`, then:
```bash
node -e "
import('@octopus/gateway').then(g => g.startSlackGateway({
  appOptions: {
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
  }
}))
"
```
In Slack: mention the bot `@AgentOctopus what's the weather in NYC?`
Expected: bot replies with weather data in the same thread.

**Telegram:** Set `TELEGRAM_BOT_TOKEN` in `.env`, then:
```bash
node -e "
import('@octopus/gateway').then(g => g.startTelegramGateway({ token: process.env.TELEGRAM_BOT_TOKEN }))
"
```
In Telegram: send `/ask translate hello to Korean` to the bot.
Expected: bot replies `"hello" in Korean: 안녕하세요`.

---

## Pass / Fail Checklist

| # | Test | Pass |
|---|---|---|
| 1.1 | CLI `list` shows 3 skills | ☐ |
| 1.2 | CLI weather query returns real data | ☐ |
| 1.3 | CLI translation returns real translation | ☐ |
| 1.4 | CLI IP lookup returns geolocation | ☐ |
| 1.5 | `ratings.json` updated after feedback | ☐ |
| 1.6 | `pnpm test` — 35 tests all green | ☐ |
| 2.1 | `POST /api/ask` weather | ☐ |
| 2.2 | `POST /api/ask` translation | ☐ |
| 2.3 | `POST /api/ask` IP lookup | ☐ |
| 2.4 | `POST /api/ask` 400 on missing query | ☐ |
| 2.5 | `POST /api/feedback` thumbs up | ☐ |
| 2.6 | `POST /api/feedback` thumbs down | ☐ |
| 2.7 | `POST /api/feedback` 404 on unknown skill | ☐ |
| 2.8 | Web UI loads, example pills work, feedback buttons work | ☐ |
| 3.1 | Agent gateway starts on port 3002 | ☐ |
| 3.2 | `GET /agent/health` returns `skills: 3` | ☐ |
| 3.3 | `POST /agent/ask` returns sessionId | ☐ |
| 3.4 | Second request with same sessionId reuses session | ☐ |
| 3.5 | `POST /agent/ask` 400 on missing query | ☐ |
| 3.6 | `POST /agent/feedback` succeeds | ☐ |
| 3.7 | `POST /agent/feedback` 400 on missing field | ☐ |
| 3.8 | Gateway unit tests — 10 green | ☐ |

## Phase 4 — Deployment & Skill Sync

### 4.1 GET /agent/skills/export

```bash
curl -s http://localhost:3002/agent/skills/export | jq '.skills | length'
```

**Expected:** Returns number of skills (e.g., `3`), each with `name`, `version`, `skillMd`, `scripts` fields.

---

### 4.2 POST /agent/sync — sync from cloud

Start a cloud instance on port 3002, then in a separate terminal start a local instance on port 3003:

```bash
# Cloud instance
DEPLOY_MODE=cloud AGENT_GATEWAY_PORT=3002 node packages/gateway/dist/bin/start-agent-gateway.js

# Local instance (separate terminal, empty registry)
DEPLOY_MODE=local AGENT_GATEWAY_PORT=3003 REGISTRY_PATH=/tmp/octopus-test-skills node packages/gateway/dist/bin/start-agent-gateway.js
```

Trigger sync:
```bash
curl -s -X POST http://localhost:3003/agent/sync \
  -H 'Content-Type: application/json' \
  -d '{"cloudUrl": "http://localhost:3002"}' | jq .
```

**Expected:** `{ "success": true, "added": ["weather", "translation", "ip-lookup"], "updated": [], "skipped": [], "errors": [] }`

---

### 4.3 CLI sync

```bash
node apps/cli/dist/index.js sync --cloud-url http://localhost:3002
```

**Expected:** Output shows added/updated/skipped skills.

---

### 4.4 Docker build (cloud)

```bash
docker compose --profile cloud build
```

**Expected:** Build completes without errors.

---

### 4.5 Docker build (local)

```bash
docker compose --profile local build
```

**Expected:** Build completes without errors.

---

## Pass / Fail Checklist (continued)

| # | Test | Pass |
|---|---|---|
| 4.1 | `GET /agent/skills/export` returns full skill data | ☐ |
| 4.2 | `POST /agent/sync` syncs skills from cloud | ☐ |
| 4.3 | `octopus sync` CLI command works | ☐ |
| 4.4 | Docker cloud build succeeds | ☐ |
| 4.5 | Docker local build succeeds | ☐ |
