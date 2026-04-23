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
| 1.7 | `octopus start` (global install, outside repo) starts gateway on :3002 without error | ☐ |
| 1.8 | `curl http://localhost:3002/agent/health` returns JSON with skill count after `octopus start` | ☐ |
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

### 4.4 octopus sync-awesome — dry run (no writes)

```bash
node apps/cli/dist/index.js sync-awesome --dry-run --limit 5
```

**Expected:** Prints up to 5 skill slugs prefixed with cyan color, then `Total: 5`. No new directories created under `registry/skills/`.

---

### 4.5 octopus sync-awesome — install with limit

```bash
node apps/cli/dist/index.js sync-awesome --limit 3
```

**Expected:** Installs 3 skills. Each creates a directory under `registry/skills/<slug>/` containing at minimum `SKILL.md` and `.clawhub-origin.json`. Final line shows `Installed: 3  Skipped: 0  Failed: 0`.

---

### 4.6 octopus sync-awesome — category filter

```bash
node apps/cli/dist/index.js sync-awesome --category git-and-github --dry-run
```

**Expected:** Lists only skills from the `git-and-github` category. Slug count is smaller than the full list.

---

### 4.7 octopus sync-awesome — skip already-installed

Run sync-awesome twice without --force:

```bash
node apps/cli/dist/index.js sync-awesome --limit 2
node apps/cli/dist/index.js sync-awesome --limit 2
```

**Expected:** Second run shows `Installed: 0  Skipped: 2  Failed: 0` and each line shows `(already installed, use --force to overwrite)`.

---

### 4.8 Docker build (cloud)

```bash
docker compose --profile cloud build
```

**Expected:** Build completes without errors.

---

### 4.9 Docker build (local)

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

## Phase 5 — Bundled Skills & Skill Creation

### 5.1 `octopus onboard` — bundled skills copied

Run the onboarding wizard and confirm all four bundled skills appear in the target skills directory:

```bash
octopus onboard
# Follow prompts; accept default skills directory (~/.agentoctopus/skills/)
ls ~/.agentoctopus/skills/
```

**Expected:** Directories for `weather`, `translation`, `ip-lookup`, and `x-search` are present, each containing a `SKILL.md`.

---

### 5.2 `octopus onboard` — credential prompt for x-search

Re-run onboarding, enable `x-search` in the skill selection step, and enter a dummy or real `XAI_API_KEY`:

```bash
octopus onboard
# Enable x-search when prompted; enter an API key value
cat ~/.agentoctopus/octopus.json
```

**Expected:** `octopus.json` contains an entry for `XAI_API_KEY`.

---

### 5.3 `octopus skill create --template`

```bash
octopus skill create --template
```

**Expected:**
- No prompts shown.
- A `SKILL.md` and `scripts/invoke.js` scaffold are written to `<skillsDir>/my-skill/` (or the name chosen).
- Both files contain placeholder content ready to fill in.

---

### 5.4 `octopus skill create` (AI wizard)

```bash
octopus skill create
```

**Expected:**
- Wizard prompts for skill name, description, and other details.
- LLM generates a `SKILL.md` manifest; content is displayed for review.
- On confirming "Yes", files are written to the skills directory.
- Option to regenerate with additional notes is available.

---

### 5.5 `octopus skill list`

```bash
octopus skill list
```

**Expected:** Output is equivalent to `octopus list` — lists all skills in the active skills directory with names, ratings, adapter type, and invocation count.

---

### 5.6 `bootstrap()` reads from `octopus.json`

After completing `octopus onboard`, run a query that exercises the bundled skills directory:

```bash
octopus ask "weather in Tokyo"
```

**Expected:** The query routes to the `weather` skill loaded from `~/.agentoctopus/skills`, not from the repo `registry/skills/` directory.

---

### 5.7 `octopus connect openclaw`

```bash
octopus connect openclaw
```

**Expected:**
- Reads `~/.openclaw/agents/main/agent/auth-profiles.json`
- Prints the found provider, model, and a key prefix (e.g., `sk-...`)
- Writes all 8 credential keys to `~/.agentoctopus/octopus.json`

> Requires OpenClaw installed with at least one auth profile configured.

---

## Pass / Fail Checklist (Phase 5)

| # | Test | Pass |
|---|---|---|
| 5.1 | `octopus onboard` — Step 0 copies bundled skills | ☐ |
| 5.2 | `octopus onboard` — credential prompt for x-search saves `XAI_API_KEY` to `octopus.json` | ☐ |
| 5.3 | `octopus skill create --template` writes `SKILL.md` + `scripts/invoke.js` scaffold | ☐ |
| 5.4 | `octopus skill create` (AI wizard) prompts, generates, and writes `SKILL.md` on "Yes" | ☐ |
| 5.5 | `octopus skill list` shows same output as `octopus list` | ☐ |
| 5.6 | After `octopus onboard`, `octopus ask "weather in Tokyo"` uses `~/.agentoctopus/skills` | ☐ |
| 5.7 | `octopus connect openclaw` reads auth profile, prints provider/model/key-prefix, writes 8 keys to `octopus.json` | ☐ |

---

## Skills Index Bundle (Phase: sync-awesome)

### 6.1 `octopus sync-awesome --dry-run --limit 3`

```bash
node apps/cli/dist/index.js sync-awesome --dry-run --limit 3
```

**Expected:** Prints "Dry run — skills that would be installed" with up to 3 slugs. No files written.

### 6.2 `octopus config set`

```bash
node apps/cli/dist/index.js config set MY_KEY abc123
```

**Expected:** Prints confirmation that `MY_KEY` was saved.

### 6.3 `octopus config list`

```bash
node apps/cli/dist/index.js config list
```

**Expected:** Shows `MY_KEY` with masked value.

### 6.4 Config persisted to disk

```bash
cat ~/.agentoctopus/octopus.json
```

**Expected:** Contains `"MY_KEY": "abc123"` in the `credentials` field.

### 6.5 Missing env var error

Invoke a skill that has `credentials` set with a key not in `process.env`. Expected error:

```
✘ Skill "..." requires environment variables that are not set:

  SOME_KEY

Run: octopus config set SOME_KEY <your-value>
```

## Pass / Fail Checklist (Phase 6 — Skills Index Bundle)

| # | Test | Pass |
|---|---|---|
| 6.1 | `sync-awesome --dry-run --limit 3` lists slugs, writes nothing | ☐ |
| 6.2 | `octopus config set MY_KEY abc123` prints confirmation | ☐ |
| 6.3 | `octopus config list` shows MY_KEY masked | ☐ |
| 6.4 | `octopus.json` contains the key after set | ☐ |
| 6.5 | Missing env var produces descriptive error with `octopus config set` hint | ☐ |

---

## Phase 9 — Update & Sync Commands

### 9.1 Check for package updates

```bash
node apps/cli/dist/index.js update --check
```

**Expected:** Table showing @agentoctopus packages with current and latest versions. Exit code 0 if up to date, 1 if updates available.

### 9.2 Check for skill updates

```bash
node apps/cli/dist/index.js sync --check
```

**Expected:** List of installed skills with available updates, or "All installed skills are up to date."

### 9.3 Sync skills (dry run)

```bash
node apps/cli/dist/index.js sync --dry-run --limit 5
```

**Expected:** Preview of up to 5 skills that would be installed, without making changes.

### 9.4 Sync skills with category filter

```bash
node apps/cli/dist/index.js sync --category git-and-github --dry-run
```

**Expected:** Preview of git-and-github category skills only.

### 9.5 Sync from cloud instance

```bash
node apps/cli/dist/index.js sync --cloud-url https://your-cloud-instance.com
```

**Expected:** Three-phase output: version check → awesome install → cloud sync results.

---

### 9.6 Debug mode — ask

```bash
node apps/cli/dist/index.js ask --debug "What's the weather in Tokyo?"
```

**Expected:** `[debug]` lines appear inline showing `isSkillEligible` decisions, cosine scores, reranker I/O, adapter chosen, and timing — followed by the normal skill response.

### 9.7 Debug mode — sync

```bash
node apps/cli/dist/index.js sync --debug
```

**Expected:** `[debug]` lines show version comparison table (installed vs available) and HTTP fetch timing alongside the normal sync output.

---

## Pass / Fail Checklist (Phase 9 — Update & Sync)

| # | Test | Pass |
|---|---|---|
| 9.1 | `octopus update --check` shows version table | ☐ |
| 9.2 | `octopus sync --check` shows skill update status | ☐ |
| 9.3 | `octopus sync --dry-run` previews skills without writing | ☐ |
| 9.4 | `octopus sync --category git-and-github --dry-run` filters correctly | ☐ |
| 9.5 | `octopus sync --cloud-url` produces three-phase output | ☐ |
| 9.6 | `octopus ask --debug` shows `[debug]` routing internals inline | ☐ |
| 9.7 | `octopus sync --debug` shows `[debug]` version table and HTTP timing | ☐ |
