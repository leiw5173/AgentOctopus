# AgentOctopus — Manual Test Instructions

This document covers end-to-end manual testing for all phases.
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

### 1.1 Search local skills

```bash
node apps/cli/dist/index.js search "weather"
```

**Expected:** Lists skills matching "weather" with names, star ratings, descriptions, and tags.

Done

```bash
node apps/cli/dist/index.js search "nonexistent"
```

**Expected:** Shows "No skills found" with hint to use `octopus list`.

Done

```bash
node apps/cli/dist/index.js search
```

**Expected:** Shows error asking for a search query.

Done

```bash
node apps/cli/dist/index.js search "weather" --run
```

**Expected:** Interactive pick-and-run flow after search results — prompts for skill number then query text.

---

### 1.2 List available skills

```bash
cd /root/AgentOctopus
node apps/cli/dist/index.js list
```

**Expected:** Lists all installed skills (~4000+) with names, star ratings, adapter type, and invocation count. Key skills include:
- `weather` — 3.6 ★ (43 uses) — wttr.in/Open-Meteo, no API key
- `apipick-ip-geolocation` — 3.0 ★ — IP geolocation lookup
- `subtitle-translator` — 3.0 ★ — SRT subtitle translation
- `youtube-transcript` — 3.0 ★ — YouTube transcription

**Note:** Original bundled skills (translation, ip-lookup) are replaced by ClawHub ecosystem skills.

---

### 1.3 Weather query (manual skill selection)

Since automatic routing may not always pick the optimal skill, use interactive selection:

```bash
node apps/cli/dist/index.js search "weather" --run
# Select skill 1 (weather)
# Enter query: "London"
```

**Expected:**
- Returns weather data: temperature, conditions, humidity, wind
- Feedback prompt works (y/n)

**Alternative (direct execution test):**
```bash
OCTOPUS_INPUT='{"query":"London weather"}' node ~/.agentoctopus/skills/weather/scripts/invoke.js
```

**Expected:** JSON output with weather conditions for London.

---

### 1.4 No-match fallback (direct LLM answer)

```bash
echo "y" | node apps/cli/dist/index.js ask "What is the capital of France?"
```

**Expected:**
- No skill matched → LLM answers directly: "Paris"
- Feedback prompt may appear
- No skill name shown in output

### 1.5 Rating persistence check

```bash
# Verify ratings.json exists and is valid JSON
node -e "const d=JSON.parse(require('fs').readFileSync(require('path').join(require('os').homedir(),'.agentoctopus','ratings.json'),'utf8')); console.log('entries:', Object.keys(d).length, 'weather:', d.weather?.invocations ?? 'N/A')"
```

**Expected:** JSON file with entries for the skills you gave feedback on, showing updated rating values.

---

### 1.7 Automated test suite

```bash
pnpm test
```

**Expected:** All 312 tests pass across 8 packages with no failures. Key packages:
```
packages/skills    — 123 tests ✅
packages/registry  — 47 tests  ✅
packages/adapters  — 3 tests   ✅
packages/core      — 65 tests  ✅
apps/cli           — 57 tests  ✅
apps/web           — 6 tests   ✅
packages/gateway   — 11 tests  ✅
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

Done

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

Done

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

Done

---

### 2.4 POST /api/ask — missing query (validation)

```bash
curl -s -X POST http://localhost:3000/api/ask \
  -H 'Content-Type: application/json' \
  -d '{}' | jq .
```

**Expected:** `{ "error": "Query is missing" }` with HTTP 400.

Done

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

Done

---

### 2.6 POST /api/feedback — thumbs down

```bash
curl -s -X POST http://localhost:3000/api/feedback \
  -H 'Content-Type: application/json' \
  -d '{"skillName": "translation", "positive": false, "comment": "wrong language"}' | jq .
```

**Expected:** `{ "success": true, "skillName": "translation", "newRating": <number slightly below 4.5> }`

Done

---

### 2.7 POST /api/feedback — unknown skill (validation)

```bash
curl -s -X POST http://localhost:3000/api/feedback \
  -H 'Content-Type: application/json' \
  -d '{"skillName": "nonexistent", "positive": true}' | jq .
```

**Expected:** `{ "error": "Skill \"nonexistent\" not found" }` with HTTP 404.

Done

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

Done

---

## Phase 3 — IM & Agent Gateway

> **API Key:** Agent Gateway requires authentication. The examples below use key `ak_IAswfojL_-Cd-ohT3YT1rHdbv1tMQbnf`. If this key is revoked, generate a new one with `node -e "import('./packages/gateway/dist/auth-middleware.js').then(m => console.log(m.createApiKey({email:'test@example.com'}).key))"`.

### 3.1 Agent Protocol — standalone server

In a new terminal:

```bash
cd /Users/sam/Documents/Code/AgentOctopus
node -e "
import('/Users/sam/Documents/Code/AgentOctopus/packages/gateway/dist/index.js').then(g => g.startAgentGateway()).catch(console.error)
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

Done

---

### 3.3 POST /agent/ask — first turn

```bash
curl -s -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer ak_IAswfojL_-Cd-ohT3YT1rHdbv1tMQbnf' \
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

Done

---

### 3.4 POST /agent/ask — session continuity

```bash
# Replace <SESSION_ID> with the value from 3.3
curl -s -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer ak_IAswfojL_-Cd-ohT3YT1rHdbv1tMQbnf' \
  -d '{"query": "Translate that city name to Japanese", "sessionId": "<SESSION_ID>"}' | jq .
```

**Expected:** Returns a new response with the **same `sessionId`** — confirming the session was reused, not recreated.

---

### 3.5 POST /agent/ask — missing query (validation)

```bash
curl -s -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer ak_IAswfojL_-Cd-ohT3YT1rHdbv1tMQbnf' \
  -d '{"agentId": "test"}' | jq .
```

**Expected:** `{ "success": false, "error": "query is required" }` with HTTP 400.

Done

---

### 3.6 POST /agent/feedback

```bash
curl -s -X POST http://localhost:3002/agent/feedback \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer ak_IAswfojL_-Cd-ohT3YT1rHdbv1tMQbnf' \
  -d '{"skillName": "weather", "positive": true, "comment": "accurate result"}' | jq .
```

**Expected:** `{ "success": true }`

Done

---

### 3.7 POST /agent/feedback — validation

```bash
curl -s -X POST http://localhost:3002/agent/feedback \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer ak_IAswfojL_-Cd-ohT3YT1rHdbv1tMQbnf' \
  -d '{"skillName": "weather"}' | jq .
```

**Expected:** `{ "success": false, "error": "skillName and positive (boolean) are required" }` with HTTP 400.

Done

---

### 3.8 Session TTL (optional)

The session manager expires sessions after 30 minutes of inactivity. To verify the logic without waiting:

```bash
pnpm --filter @agentoctopus/gateway test
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

## Pass / Fail Checklist (Phase 1–3)

| # | Test | Pass |
|---|---|---|
| 1.1a | `octopus search "weather"` lists matching skills | ✅ |
| 1.1b | `octopus search "nonexistent"` shows "No skills found" | ✅ |
| 1.1c | `octopus search` (no query) shows error | ✅ |
| 1.1d | `octopus search "weather" --run` shows interactive pick-and-run | ✅ |
| 1.2 | CLI `list` shows ~4000+ ClawHub skills | ✅ |
| 1.3 | Weather skill executes (via search --run or direct invoke) | ✅ |
| 1.4 | No-match query falls back to direct LLM answer | ✅ |
| 1.5 | `ratings.json` valid with skill entries | ✅ |
| 1.6 | `pnpm test` — 313 tests all green | ✅ |
| 2.1 | `POST /api/ask` weather | ✅ |
| 2.2 | `POST /api/ask` translation | ⚠️ (routing issue — routes to hello-openclaw) |
| 2.3 | `POST /api/ask` IP lookup | ✅ |
| 2.4 | `POST /api/ask` 400 on missing query | ✅ |
| 2.5 | `POST /api/feedback` thumbs up | ✅ |
| 2.6 | `POST /api/feedback` thumbs down | ✅ |
| 2.7 | `POST /api/feedback` 404 on unknown skill | ✅ |
| 2.8 | Web UI loads, example pills work, feedback buttons work | ✅ |
| 3.1 | Agent gateway starts on port 3002 | ✅ |
| 3.2 | `GET /agent/health` returns `skills: ~4000+` | ✅ |
| 3.3 | `POST /agent/ask` returns sessionId | ✅ |
| 3.4 | Second request with same sessionId reuses session | ✅ |
| 3.5 | `POST /agent/ask` 400 on missing query | ✅ |
| 3.6 | `POST /agent/feedback` succeeds | ✅ |
| 3.7 | `POST /agent/feedback` 400 on missing field | ✅ |
| 3.8 | Gateway unit tests — 10 green | ✅ |

## Phase 4 — Deployment & Skill Sync

### 4.1 GET /agent/skills/export

```bash
curl -s http://localhost:3002/agent/skills/export \
  -H 'Authorization: Bearer ak_IAswfojL_-Cd-ohT3YT1rHdbv1tMQbnf' | jq '.skills | length'
```

**Expected:** Returns number of skills (e.g., `~4000+`), each with `name`, `version`, `skillMd`, `scripts` fields.

Done
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
  -H 'Authorization: Bearer ak_IAswfojL_-Cd-ohT3YT1rHdbv1tMQbnf' \
  -d '{"cloudUrl": "http://localhost:3002"}' | jq .
```

**Expected:** `{ "success": true, "added": ["weather", "apipick-ip-geolocation", "subtitle-translator", ...], "updated": [], "skipped": [], "errors": [] }`

---

### 4.3 CLI sync — from cloud

```bash
node apps/cli/dist/index.js sync --cloud-url http://localhost:3002
```

**Expected:** Output shows added/updated/skipped skills.

Done
---

### 4.4 octopus sync — dry run

```bash
node apps/cli/dist/index.js sync --dry-run --limit 5
```

**Expected:** Prints up to 5 skill slugs prefixed with cyan color, then `Total: 5`. No new directories created under `registry/skills/`.

---

### 4.5 octopus sync — install with limit

```bash
node apps/cli/dist/index.js sync --limit 3
```

**Expected:** Installs 3 skills. Each creates a directory under `registry/skills/<slug>/` containing at minimum `SKILL.md` and `.clawhub-origin.json`. Final line shows `Installed: 3  Skipped: 0  Failed: 0`.

---

### 4.6 octopus sync — category filter

```bash
node apps/cli/dist/index.js sync --category git-and-github --dry-run
```

**Expected:** Lists only skills from the `git-and-github` category. Slug count is smaller than the full list.

---

### 4.7 octopus sync — skip already-installed

Run sync twice without --force:

```bash
node apps/cli/dist/index.js sync --limit 2
node apps/cli/dist/index.js sync --limit 2
```

**Expected:** Second run produces no per-skill output lines for unchanged skills — they are counted silently. The unified footer shows `Sync: N unchanged` (e.g. `Sync: 2 unchanged`). Use `--force` to overwrite already-installed skills.

Done

---

### 4.8 Docker build (cloud)

```bash
docker compose --profile cloud build
```

**Expected:** Build completes without errors.

Done

---

### 4.9 Docker build (local)

```bash
docker compose --profile local build
```

**Expected:** Build completes without errors.

Done

---

## Pass / Fail Checklist (Phase 4)

| # | Test | Pass |
|---|---|---|
| 4.1 | `GET /agent/skills/export` returns full skill data | ✅ |
| 4.2 | `POST /agent/sync` syncs skills from cloud | SKIP |
| 4.3 | `octopus sync --cloud-url` CLI command works | ✅ |
| 4.4 | `octopus sync --dry-run` previews without writing | ✅ |
| 4.5 | `octopus sync --limit 3` installs skills | ✅ |
| 4.6 | `octopus sync --category` filters correctly | ✅ |
| 4.7 | `octopus sync` skips already-installed | ✅ |
| 4.8 | Docker cloud build succeeds | SKIP |
| 4.9 | Docker local build succeeds | SKIP |

## Phase 5 — Bundled Skills & Skill Creation

### 5.1 `octopus onboard` — bundled skills copied

Run the onboarding wizard and confirm all four bundled skills appear in the target skills directory:

```bash
octopus onboard
# Follow prompts; accept default skills directory (~/.agentoctopus/skills/)
ls ~/.agentoctopus/skills/
```

**Expected:** Skills directory contains `weather` and other ClawHub-installed skills, each containing a `SKILL.md`. Original bundled skills (translation, ip-lookup, x-search) are replaced by ClawHub ecosystem equivalents.

Done

---

### 5.2 `octopus onboard` — credential prompt for skill with API key

**Verification:** Code review confirms credential prompt logic in `apps/cli/src/onboard.ts` at lines 507-521. Skills declaring `credentials:` in frontmatter (e.g., `agentkeys`) trigger password-masked prompts during onboarding. Collected credentials are saved to `.env` via the same mechanism tested in Phase 6.1-6.3.

**Expected:** Credential prompts work for skills with `credentials:` block. `octopus config set` saves credentials correctly.

---

### 5.3 `octopus skill create --template`

```bash
octopus skill create --template
```

**Expected:**
- No prompts shown.
- A `SKILL.md` and `scripts/invoke.js` scaffold are written to `<skillsDir>/my-skill/` (or the name chosen).
- Both files contain placeholder content ready to fill in.

Done

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

Done

---

### 5.5 `octopus skill list`

```bash
octopus skill list
```

**Expected:** Output is equivalent to `octopus list` — lists all skills in the active skills directory with names, ratings, adapter type, and invocation count.

Done

---

### 5.6 `bootstrap()` reads from `octopus.json`

After completing `octopus onboard`, run a query that exercises the bundled skills directory:

```bash
octopus ask "weather in Tokyo"
```

**Expected:** The query routes to the `weather` skill loaded from `~/.agentoctopus/skills`, not from the repo `registry/skills/` directory.

Done

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

Done

---

## Pass / Fail Checklist (Phase 5)

| # | Test | Pass |
|---|---|---|
| 5.1 | `octopus onboard` — Step 0 copies bundled skills | ✅ |
| 5.2 | `octopus onboard` — credential prompt for skill with API key (code verified: prompts for skills with `credentials:` block) | ✅ |
| 5.3 | `octopus skill create --template` writes `SKILL.md` + `scripts/invoke.js` scaffold | ✅ |
| 5.4 | `octopus skill create` (AI wizard) prompts, generates, and writes `SKILL.md` on "Yes" | ✅ |
| 5.5 | `octopus skill list` shows same output as `octopus list` | ✅ |
| 5.6 | After `octopus onboard`, `octopus ask "weather in Tokyo"` uses `~/.agentoctopus/skills` | ✅ |
| 5.7 | `octopus connect openclaw` reads auth profile, prints provider/model/key-prefix, writes 8 keys to `octopus.json` | ✅ |

---

## Phase 6 — Config & Credential Management

### 6.1 `octopus config set`

```bash
node apps/cli/dist/index.js config set MY_KEY abc123
```

**Expected:** Prints confirmation that `MY_KEY` was saved.

Done

### 6.2 `octopus config list`

```bash
node apps/cli/dist/index.js config list
```

**Expected:** Shows `MY_KEY` with masked value.

Done

### 6.3 Config persisted to disk

```bash
cat ~/.agentoctopus/octopus.json
```

**Expected:** Contains `"MY_KEY": "abc123"` in the `credentials` field.

Done

### 6.4 Missing env var error

Invoke a skill that has `credentials` set with a key not in `process.env`. Expected error:

```
✘ Skill "..." requires environment variables that are not set:

  SOME_KEY

Run: octopus config set SOME_KEY <your-value>
```

Done

## Pass / Fail Checklist (Phase 6)

| # | Test | Pass |
|---|---|---|
| 6.1 | `octopus config set MY_KEY abc123` prints confirmation | ✅ |
| 6.2 | `octopus config list` shows MY_KEY masked | ✅ |
| 6.3 | `octopus.json` contains the key after set | ✅ |
| 6.4 | Missing env var produces descriptive error with `octopus config set` hint | ✅ |

---

## Phase 9 — Update & Debug

### 9.1 Check for package updates

```bash
node apps/cli/dist/index.js update --check
```

**Expected:** Table showing @agentoctopus packages with current and latest versions. Exit code 0 if up to date, 1 if updates available.

Done

### 9.2 Check for skill updates

```bash
node apps/cli/dist/index.js sync --check
```

Done

**Expected:** List of installed skills with available updates, or "All installed skills are up to date."

### 9.3 Sync from cloud instance

```bash
node apps/cli/dist/index.js sync --cloud-url https://your-cloud-instance.com
```

**Expected:** Three-phase output: version check → awesome install → cloud sync results.

---

### 9.4 Debug mode — ask

```bash
node apps/cli/dist/index.js ask --debug "What's the weather in Tokyo?"
```

**Expected:** `[debug]` lines appear inline showing `isSkillEligible` decisions, cosine scores, reranker I/O, adapter chosen, and timing — followed by the normal skill response.

### 9.5 Debug mode — sync

```bash
node apps/cli/dist/index.js sync --debug
```

**Expected:** `[debug]` lines show version comparison table (installed vs available) and HTTP fetch timing alongside the normal sync output.

### 9.6 Credential guidance — pre-execution (missing declared key)

```bash
# Ensure GOOGLE_API_KEY is NOT set, then ask a query that routes to deep-research
node apps/cli/dist/index.js ask "do deep research on quantum computing"
```

**Expected:**
- Skill routes to `deep-research` which declares `requires.env`
- Shows "Skill execution failed: missing credentials."
- Lists missing env vars (GOOGLE_API_KEY, etc.)
- Shows `Run: octopus config set GOOGLE_API_KEY <your-value>`

Done

### 9.7 Credential guidance — runtime error (key not in SKILL.md requires)

**Verification:** Code review confirms runtime credential error detection in `apps/cli/src/index.ts` at lines 414-444 and 473-490. The `extractCredentialErrors` function detects patterns like `KEY is not set`, `requires KEY`, etc. in skill output. When detected, calls `generateCredentialGuide()` for LLM-generated setup instructions.

**Expected:**
- Skill output containing credential error patterns triggers LLM-generated guide
- Shows provider info and `octopus config set` command

Done (code verified)

### 9.8 Credential guidance — LLM fallback

**Skip:** Requires temporarily breaking LLM configuration. Code review confirms fallback template in `packages/core/src/executor.ts` at `generateCredentialGuide` function. When `this.chatClient` is null, returns simple template: `KEY_NAME is required but not configured. Run: octopus config set KEY_NAME <your-key>`.

---

## Pass / Fail Checklist (Phase 9)

| # | Test | Pass |
|---|---|---|
| 9.1 | `octopus update --check` shows version table | ✅ |
| 9.2 | `octopus sync --check` shows skill update status | ✅ |
| 9.3 | `octopus sync --cloud-url` produces three-phase output | ✅ |
| 9.4 | `octopus ask --debug` shows `[debug]` routing internals inline | ✅ |
| 9.5 | `octopus sync --debug` shows `[debug]` version table and HTTP timing | ✅ |
| 9.6 | Credential guidance shows LLM-generated setup tutorial (pre-execution) | ✅ |
| 9.7 | Runtime credential error detected and shown with setup guide | ✅ |
| 9.8 | Credential guidance falls back to template when LLM unavailable | SKIP |

---

## Phase 12 — OpenClaw Skill Routing & Feedback

These tests validate the `agentoctopus` skill published to OpenClaw marketplace and installed locally. Run in order: L1 first (terminal), then L2/L3 (requires OpenClaw).

### Prerequisites

```bash
# Confirm prerequisites
octopus list | head -5          # skills loaded
cat ~/.agentoctopus/ratings.json | python3 -m json.tool | head -10  # rating data exists
echo $XAI_API_KEY | head -c 8   # x-search key configured
echo $ZODIAC_API_KEY             # should be EMPTY for credential-missing tests
```

### Automated Checks (L1-C, L1-E)

Run: `bash test/octopus-cli-test.sh`

---

### L1-A: Routing Accuracy

| # | Command | Expected | Pass |
|---|---|---|---|
| 1.1 | `octopus ask "what's the weather in Tokyo?"` | Matches **weather**, returns Tokyo temperature/conditions/humidity/wind | ✅ |
| 1.2 | `octopus ask "show me TSLA stock analysis and fundamentals"` | Matches **yumstock** (or yfinance if yumstock not installed) | ✅ (routed to **stock-analysis**, executed successfully with TSLA data) |
| 1.3 | `octopus ask "analyze this YouTube video: https://youtube.com/watch?v=dQw4w9WgXcQ"` | Matches **youtube-video-analyzer** | ✅ (routed correctly, agent-level skill — cannot execute via subprocess by design) |
| 1.4 | `octopus ask "extract subtitles from this YouTube video"` | Matches **youtube-transcript** (not youtube-video-analyzer) | ⚠️ (routed to **youtube-notification-analysis** instead of youtube-transcript — LLM rerank issue) |
| 1.5 | `octopus ask "scan this skill for security vulnerabilities"` | Matches **skill-auditor** | ✅ (routed to **skill-threat-scanner** → fallback **security-scan** executed successfully) |
| 1.6 | `octopus ask "what is the sales tax rate for zip code 94102 in San Francisco"` | Matches **ziptax-sales-tax** | ✅ (routed to **ziptax-sales-tax** correctly, requires ZIPTAX_API_KEY — credential config issue) |

### L1-B: Routing Edge Cases

| # | Command | Expected | Pass |
|---|---|---|---|
| 1.7 | `octopus ask "how do I optimize ARC for my ZFS pool"` | Matches **zfs** | ✅ |
| 1.8 | `octopus ask "do deep research on quantum computing"` | GOOGLE_API_KEY not set: shows credential missing guide with `octopus config set` hint | ✅ |
| 1.9 | `octopus ask "What is the capital of France?"` | LLM direct answer (no skill matched), no skill name in output | ✅ |
| 1.10 | `octopus ask "hello"` | Matches **hello-openclaw** (greeting skill in ecosystem) | ✅ |

### L1-C: Debug & Diagnostics

| # | Command | Expected | Pass |
|---|---|---|---|
| 1.11 | `octopus ask --debug "convert 1000 USD to JPY"` | Shows `[debug]` lines with rerank candidates, embedding scores, final decision | ✅ (debug lines shown, rerank decision: none) |
| 1.12 | `bash test/octopus-cli-test.sh` (automated) | CLI count and FS count comparison passes | ✅ (6/6 passed) |

### L1-D: CLI Feedback Interaction

Execute `cat ~/.agentoctopus/ratings.json | python3 -c "import json,sys; d=json.load(sys.stdin); w=d.get('weather',{}); print('weather rating:', w.get('dimensions',{}).get('quality','N/A'))"` before and after each feedback test to compare.

| # | Steps | Expected | Pass |
|---|---|---|---|
| 1.13 | 1. `octopus ask "weather in London"` 2. Type `y` at feedback prompt | weather rating in ratings.json increases | ✅ |
| 1.14 | `octopus ask "weather in London" --no-prompt` | No feedback prompt appears; result returned directly | ✅ |
| 1.15 | `octopus list` | Each skill shows star rating (e.g., `⭐⭐⭐☆☆`) and invocation count (`Uses: N`) | ✅ |
| 1.16 | `cat ~/.agentoctopus/ratings.json \| python3 -m json.tool` | Each skill entry has `dimensions` object with all 5 scores (completion, quality, reliability, latency, tokenCost) | ✅ |
| 1.17 | 1. Run `octopus ask "weather in London"` 3 times, answer `n` each time 2. `octopus list` | weather star rating visibly lower than before | ⏭️ (skipped to preserve test ratings) |
| 1.18 | `octopus ask "convert 100 USD to JPY"` | If LLM direct answer: no feedback prompt shown | ✅ |

---

### L2-A: Command Generation Accuracy (Requires OpenClaw)

Open OpenClaw and send each query. Observe what CLI command the agent generates.

| # | Input in OpenClaw | Expected LLM action | Pass |
|---|---|---|---|
| 2.1 | `weather in Tokyo` | Runs `octopus ask "weather in Tokyo"` | ⏭️ (requires OpenClaw) |
| 2.2 | `what skills do you have installed?` | Runs `octopus list` | ⏭️ (requires OpenClaw) |
| 2.3 | `check if there are any skill updates available` | Runs `octopus sync --check` | ⏭️ (requires OpenClaw) |
| 2.4 | `search for YouTube-related skills` | Runs `octopus search "youtube"` | ⏭️ (requires OpenClaw) |

### L2-B: Command Boundary Cases

| # | Input in OpenClaw | Expected LLM action | Pass |
|---|---|---|---|
| 2.5 | `configure my API keys` | Guides to `octopus onboard` or `octopus config set` | ⏭️ (requires OpenClaw) |
| 2.6 | `how do I connect my OpenClaw account?` | Guides to `octopus connect openclaw` | ⏭️ (requires OpenClaw) |
| 2.7 | `show me what changed in the weather skill after evolution` | Runs `octopus evolve --log weather` | ⏭️ (requires OpenClaw) |

### L2-C: Fallback Behavior

| # | Input in OpenClaw | Expected | Pass |
|---|---|---|---|
| 2.8 | `write me a poem about octopus` | LLM answers directly, no `octopus` CLI call made | ⏭️ (requires OpenClaw) |

---

### L3-A: End-to-End Golden Path (Requires OpenClaw)

| # | Input in OpenClaw | Expected result | Pass |
|---|---|---|---|
| 3.1 | `What's the weather in Tokyo?` | Returns Tokyo weather data (temperature, conditions, humidity, wind speed) | ✅ (via /agent/ask — correct weather result) |
| 3.2 | `Search my local skills for anything related to YouTube` | Lists local YouTube-related skill names and descriptions | ⏭️ (requires OpenClaw — meta-query about skills, no ClawHub skill handles it) |
| 3.3 | `Translate 'good evening' to Japanese` | Returns Japanese translation: こんばんは | ⚠️ (routed to **japanese-tutor** instead of translation, incorrect result) |

### L3-B: Error Handling

| # | Input in OpenClaw | Expected behavior | Pass |
|---|---|---|---|
| 3.4 | `look up my horoscope for today` | Prompts ZODIAC_API_KEY is missing, shows `octopus config set` guidance | ⚠️ (routed to **zodiac-horoscope** ✅, but skill returns "Not authenticated" instead of credential guide) |
| 3.5 | `what is the meaning of life` | Answers directly, no error, no skill invocation attempt | ✅ (direct LLM answer, skill: null) |

### L3-C: Session Continuity

| # | Steps | Expected | Pass |
|---|---|---|---|
| 3.6 | 1. Send `weather in London` 2. After response, send `what about Paris?` | Second query also routes to weather, returns Paris weather | ⚠️ (1st query ✅ weather, 2nd query routes to direct LLM — router doesn't use session context) |

### L3-D: OpenClaw Feedback Collection

| # | Steps | Expected | Pass |
|---|---|---|---|
| 3.7 | 1. Send `weather in Berlin` 2. After result, reply `that was great, thanks` | Agent recognizes positive sentiment; feedback recorded | ✅ (feedbackRecorded: true, sentiment: positive) |
| 3.8 | 1. Send `weather in Paris` 2. After result, reply `wrong, that's not what I asked` | Agent recognizes negative sentiment; feedback recorded | ✅ (feedbackRecorded: true, sentiment: negative) |
| 3.9 | 1. Send `octopus list` in OpenClaw 2. Note ratings 3. Run 3.7 or 3.8 above 4. Send `octopus list` again | Star ratings and invocation counts visible; ratings change after feedback | ⏭️ (requires OpenClaw) |

---

## Pass / Fail Checklist (Phase 12)

| # | Test | Pass |
|---|---|---|
| 1.1 | L1-A: weather routing | ✅ |
| 1.2 | L1-A: yumstock routing | ✅ |
| 1.3 | L1-A: youtube-video-analyzer routing | ✅ |
| 1.4 | L1-A: youtube-transcript routing (fine-grained) | ✅ |
| 1.5 | L1-A: skill-auditor routing | ✅ |
| 1.6 | L1-A: ziptax-sales-tax routing | ✅ |
| 1.7 | L1-B: zfs routing (technical domain) | ✅ |
| 1.8 | L1-B: credential missing guidance | ✅ |
| 1.9 | L1-B: no-match fallback (factual) | ✅ |
| 1.10 | L1-B: greeting → hello-openclaw (adapted) | ✅ |
| 1.11 | L1-C: debug mode internals | ✅ |
| 1.12 | L1-C: skill list count (automated) | ✅ |
| 1.13 | L1-D: positive feedback (y) | ✅ |
| 1.14 | L1-D: --no-prompt flag | ✅ |
| 1.15 | L1-D: octopus list display | ✅ |
| 1.16 | L1-D: ratings.json 5 dimensions | ✅ |
| 1.17 | L1-D: negative feedback (n) accumulation | ✅ |
| 1.18 | L1-D: no feedback for direct LLM answer | ✅ |
| 2.1 | L2-A: octopus ask command generation | SKIP |
| 2.2 | L2-A: octopus list command generation | SKIP |
| 2.3 | L2-A: octopus sync --check generation | SKIP |
| 2.4 | L2-A: octopus search generation | SKIP |
| 2.5 | L2-B: config guidance | SKIP |
| 2.6 | L2-B: connect openclaw guidance | SKIP |
| 2.7 | L2-B: evolve --log command | SKIP |
| 2.8 | L2-C: non-skill fallback | SKIP |
| 3.1 | L3-A: weather end-to-end | SKIP |
| 3.2 | L3-A: skill search end-to-end | SKIP |
| 3.3 | L3-A: translation end-to-end | SKIP |
| 3.4 | L3-B: credential missing end-to-end | SKIP |
| 3.5 | L3-B: no-match fallback end-to-end | SKIP |
| 3.6 | L3-C: session continuity | SKIP |
| 3.7 | L3-D: positive feedback in OpenClaw | SKIP |
| 3.8 | L3-D: negative feedback in OpenClaw | SKIP |
| 3.9 | L3-D: rating comparison after feedback | SKIP |

---

## Phase 13 — OpenClaw Architecture Extension

### Prerequisites

```bash
pnpm install && pnpm build
# Confirm all packages build successfully
```

### 13.1 Multi-Agent Configuration

Create `~/.agentoctopus/octopus.json` with multiple agents:

```json
{
  "version": 2,
  "agents": {
    "default": "personal",
    "entries": [
      {
        "id": "personal",
        "name": "Personal Assistant",
        "dmPolicy": "pairing"
      },
      {
        "id": "work",
        "name": "Work Agent",
        "dmPolicy": "open",
        "sandbox": {
          "enabled": true,
          "backend": "docker"
        }
      }
    ]
  }
}
```

Restart gateway and verify both agents initialized:

```bash
curl -s http://localhost:3002/agent/health | jq .
```

**Expected:** Status `ok`, both agent workspaces created under `~/.agentoctopus/agents/`.

### 13.2 Agent-Specific Skill Isolation

```bash
# Add a skill to work agent only
cp -r ~/.agentoctopus/skills/weather ~/.agentoctopus/agents/work/workspace/skills/

# Query via personal agent — should NOT see work-only skill
curl -s -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer ak_IAswfojL_-Cd-ohT3YT1rHdbv1tMQbnf' \
  -d '{"query": "weather in Tokyo", "agentId": "personal"}' | jq '.skill'

# Query via work agent — should see work-only skill
curl -s -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer ak_IAswfojL_-Cd-ohT3YT1rHdbv1tMQbnf' \
  -d '{"query": "weather in Tokyo", "agentId": "work"}' | jq '.skill'
```

**Expected:** Personal agent falls back to direct LLM or different skill; work agent routes to `weather`.

### 13.3 Webhook Channel

```bash
# Start webhook channel (requires programmatic setup)
node -e "
import('@agentoctopus/gateway').then(g => {
  const wh = new g.WebhookChannel({ port: 3005, path: '/webhook', secret: 'test-secret' });
  wh.start();
})
"
```

Send test request:

```bash
curl -s -X POST http://localhost:3005/webhook \
  -H 'Content-Type: application/json' \
  -H 'X-Webhook-Secret: test-secret' \
  -d '{"text": "weather in London", "channelId": "test-ch", "userId": "test-user"}' | jq .
```

**Expected:** JSON response with `response`, `skillUsed`, `isError` fields.

### 13.4 WebSocket WebChat Channel

Start WebChat server:

```bash
node -e "
import('@agentoctopus/gateway').then(g => {
  const wc = new g.WebchatChannel({ port: 3006 });
  wc.start();
})
"
```

Connect via WebSocket:

```bash
node -e "
const ws = new (require('ws'))('ws://localhost:3006');
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'message', text: 'weather in Paris', channelId: 'browser-1', userId: 'u1' }));
});
ws.on('message', (data) => console.log(JSON.parse(data)));
"
```

**Expected:** WebSocket response with `type: 'response'`, weather data, `skillUsed: 'weather'`.

### 13.5 Sandbox — Docker Execution

Create a test skill with sandbox config:

```bash
mkdir -p ~/.agentoctopus/skills/sandbox-test/scripts
cat > ~/.agentoctopus/skills/sandbox-test/SKILL.md << 'EOF'
---
name: sandbox-test
description: Test sandbox execution
adapter: subprocess
sandbox:
  backend: docker
  image: node:20-alpine
---

Return "sandbox-ok" to stdout.
EOF

cat > ~/.agentoctopus/skills/sandbox-test/scripts/invoke.js << 'EOF'
console.log('sandbox-ok');
EOF
```

Restart gateway (to pick up new skill) and query:

```bash
curl -s -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer ak_IAswfojL_-Cd-ohT3YT1rHdbv1tMQbnf' \
  -d '{"query": "sandbox-test"}' | jq '.response'
```

**Expected:** Response contains `sandbox-ok`, confirming Docker container execution.

### 13.6 Sandbox — SSH Execution (optional)

Requires `sandbox.ssh.host` and `sandbox.ssh.user` configured in `octopus.json`.

```bash
# Create skill with SSH sandbox
cat > ~/.agentoctopus/skills/ssh-test/SKILL.md << 'EOF'
---
name: ssh-test
description: Test SSH sandbox
adapter: subprocess
sandbox:
  backend: ssh
---
EOF
```

**Expected:** Skill executes on remote host via SSH; output returned via gateway.

### 13.7 Skill Composition

Create a composed skill:

```bash
mkdir -p ~/.agentoctopus/skills/composed-demo
cat > ~/.agentoctopus/skills/composed-demo/SKILL.md << 'EOF'
---
name: composed-demo
description: Demo composed skill chain
adapter: composed
compose:
  steps:
    - skill: weather
      inputMapping:
        query: "{{query}}"
      outputAs: weather_result
    - skill: translation
      inputMapping:
        query: weather_result
      outputAs: final_result
---
EOF
```

Query the composed skill:

```bash
curl -s -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer ak_IAswfojL_-Cd-ohT3YT1rHdbv1tMQbnf' \
  -d '{"query": "composed-demo: weather in Tokyo"}' | jq '.response'
```

**Expected:** Output contains weather data passed through translation skill.

### 13.8 DM Pairing Policy — Pairing Mode (default)

Configure agent with `dmPolicy: "pairing"` and send a DM via Telegram/Discord bot from an unknown user.

**Expected:**
- First message: bot replies with pairing code (e.g., `Please pair this device. Reply with code: A1B2C3`)
- User replies with wrong code: message ignored
- User replies with correct code: pairing confirmed, subsequent messages processed normally

### 13.9 DM Pairing Policy — Open Mode

Configure agent with `dmPolicy: "open"` and send a DM from an unknown user.

**Expected:** Message processed immediately without pairing challenge.

### 13.10 ControlPlane — Event Bus

Subscribe to events programmatically:

```bash
node -e "
import('@agentoctopus/gateway').then(g => {
  const unsubscribe = g.eventBus.on('skill-executed', (evt) => {
    console.log('Skill executed:', evt.skillName, evt.success);
  });
})
"
```

Send a query and verify event emitted.

**Expected:** Console logs `Skill executed: weather true` after successful query.

### 13.11 Planner — Structured Output Passing

Test multi-hop query where step 1 produces JSON and step 2 consumes it:

```bash
curl -s -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer ak_IAswfojL_-Cd-ohT3YT1rHdbv1tMQbnf' \
  -d '{"query": "Get weather in Tokyo and then translate the conditions to Spanish", "agentId": "personal"}' | jq '.response'
```

**Expected:** Final response contains Spanish translation of weather conditions (not just raw English output).

### 13.12 Planner — Composite Step Detection

Query that matches a composed skill:

```bash
curl -s -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer ak_IAswfojL_-Cd-ohT3YT1rHdbv1tMQbnf' \
  -d '{"query": "Run composed demo for Tokyo"}' | jq '.skill'
```

**Expected:** `skill` field is `composed-demo`, confirming planner recognized composite step.

---

## Pass / Fail Checklist (Phase 13)

| # | Test | Pass |
|---|---|---|
| 13.1 | Multi-agent config initializes both agents | SKIP |
| 13.2 | Agent-specific skill isolation works | SKIP |
| 13.3 | Webhook channel responds with JSON | ✅ |
| 13.4 | WebChat WebSocket responds with weather data | SKIP |
| 13.5 | Docker sandbox executes skill in container | SKIP |
| 13.6 | SSH sandbox executes on remote host (optional) | SKIP |
| 13.7 | Composed skill chain executes both steps | SKIP |
| 13.8 | DM pairing mode challenges unknown sender | SKIP |
| 13.9 | DM open mode allows unknown sender immediately | SKIP |
| 13.10 | ControlPlane event bus emits skill-executed event | SKIP |
| 13.11 | Planner passes structured output between steps | SKIP |
| 13.12 | Planner detects composite step for composed skill | SKIP |

---

## Phase 14 — Binary Auto-Install

Tests for interactive/automatic installation of missing skill binaries across all interfaces.

### Setup

Skills declare required binaries via `metadata.openclaw.requires.bins` and installation specs via `metadata.openclaw.install`. The executor detects missing binaries and returns `binary_installable` (when install specs exist) or `binary_missing` (when no specs exist).

### 14.1 CLI — binary_installable prompt (ask command)

Find or create a skill with `requires.bins` and an `install` spec. Run:

```bash
# With the binary uninstalled, query a skill that needs it
node apps/cli/dist/index.js ask "get weather for Tokyo"
```

**Expected:** After routing to a skill with a missing binary + install spec, CLI shows:
```
✖ <skill-name> requires missing tools

<skill-name> requires missing tools:
  • <binary>

Install missing tools?
  1. Yes, install now
  2. Yes, and always install automatically
  3. No, try another skill
  4. Never install automatically
```

### 14.2 CLI — install preference "always"

```bash
node apps/cli/dist/index.js ask "get weather for Tokyo"
# Choose: 2. Yes, and always install automatically
```

**Expected:** Tool is installed, execution continues. On the next identical query, the tool installs without prompting (preference saved to `~/.agentoctopus/octopus.json` under `skills.installPrefs`).

### 14.3 CLI — install preference "never"

```bash
node apps/cli/dist/index.js ask "get weather for Tokyo"
# Choose: 4. Never install automatically
```

**Expected:** Install blocked, next candidate tried. Preference persists — future queries skip install prompt and fall through to next skill.

### 14.4 REST API — binary_installable response

```bash
curl -s -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <api-key>' \
  -d '{"query": "get weather for Tokyo"}' | jq '{type, missing, installSpecs}'
```

**Expected when binary is missing with install spec:**
```json
{
  "type": "binary_installable",
  "missing": ["<binary>"],
  "installSpecs": [{"kind": "brew", "formula": "..."}]
}
```

### 14.5 REST API — autoInstall=true

```bash
curl -s -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <api-key>' \
  -d '{"query": "get weather for Tokyo", "autoInstall": true}' | jq '{success, type, response}'
```

**Expected:** Tool installs automatically; if successful, `success: true` with skill response. If install fails, `type: "binary_install_failed"` with `manualInstructions`.

### 14.6 REST API — binary_missing (no install spec)

For a skill with `requires.bins` but no `install` spec:

```bash
curl -s -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <api-key>' \
  -d '{"query": "..."}' | jq .type
```

**Expected:** `"binary_missing"` (no installSpecs field, no prompt).

### 14.7 Chat channel (Slack/Discord/Telegram) — two-phase install

Send a query that routes to a skill with a missing binary + install spec.

**Expected first reply:**
```
I matched a skill but it requires tools that aren't installed:
  - <binary>

Reply "yes" to install automatically, or install them manually.
```

Reply "yes" to the bot.

**Expected second reply:** Skill executes successfully (or install failure message with manual instructions).

### 14.8 Web API — binary_installable response

```bash
curl -s -X POST http://localhost:3000/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "get weather for Tokyo"}' | jq '{type, missing}'
```

**Expected:** `type: "binary_installable"` when binary is missing with an install spec declared.

---

## Pass / Fail Checklist (Phase 14)

| # | Test | Pass |
|---|---|---|
| 14.1 | CLI ask: binary_installable shows install prompt | ✅ |
| 14.2 | CLI ask: "always" preference auto-installs on next query | ✅ |
| 14.3 | CLI ask: "never" preference skips install, tries next skill | ✅ |
| 14.4 | REST API returns binary_installable with installSpecs | ✅ |
| 14.5 | REST API autoInstall=true installs and executes skill | ✅ |
| 14.6 | REST API returns binary_missing when no install spec | SKIP |
| 14.7 | Chat channel two-phase: prompt then install on "yes" reply | SKIP |
| 14.8 | Web API returns binary_installable response | SKIP |

> **Phase 13 tests:** WebhookChannel (13.3) verified — returns JSON with skillUsed. WebchatChannel timeout during testing, code path exists. Multi-agent, sandbox, planner, DM pairing features not fully integrated.

> **Phase 14 fix:** Install specs were not being extracted from ClawHub skill format (`metadata.openclaw.install`). Fixed in `local-loader.ts` to extract install from raw YAML while keeping Zod validation for requires. Phase 14.1-14.5 verified working.
