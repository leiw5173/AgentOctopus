# Rating System Redesign — Design Spec

**Date:** 2026-04-17
**Status:** Approved
**Approach:** Dimension-first with composite index (Approach B)

## Goals

1. **Skill selection quality** — richer signal for the router to pick the best skill when multiple match
2. **Skill author feedback** — actionable data (dimension breakdowns, natural language comments, cross-platform signals) so authors can improve their skills

Benchmarking is a secondary goal, deferred to a future iteration.

## Approach

**Dimension-first with composite index.** Each rating dimension is stored independently. The routing score is computed on-the-fly using task-type-aware weights. This gives per-dimension visibility for authors and adaptive routing without the complexity of full event sourcing.

## Data Model

### RatingEntry (new)

```typescript
interface RatingEntry {
  skillName: string;
  dimensions: {
    completion: number;   // 0.0–1.0, objective
    quality: number;      // 0.0–5.0, subjective
    reliability: number;  // 0.0–1.0, objective
    latency: number;      // 0.0–1.0, objective
    tokenCost: number;    // 0.0–1.0, objective
  };
  invocations: number;
  lastInvoked: string;    // ISO timestamp
  recentFeedback: FeedbackEntry[];
  metrics: {
    totalSuccess: number;
    totalErrors: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    avgTokenCost: number;
  };
}

interface FeedbackEntry {
  id: string;             // unique per feedback
  timestamp: string;      // ISO timestamp
  positive: boolean;
  comment?: string;       // natural language feedback
  source: 'cli' | 'web' | 'openclaw' | 'hermes' | 'other';
  taskType?: 'one-shot' | 'long-running' | 'agent-collab';
}
```

### Dimension Definitions

| Dimension | Range | Type | How measured |
|-----------|-------|------|-------------|
| completion | 0.0–1.0 | Objective | totalSuccess / invocations |
| quality | 0.0–5.0 | Subjective | EMA of thumbs-up/down feedback (α=0.1) |
| reliability | 0.0–1.0 | Objective | 1 - (totalErrors / invocations) |
| latency | 0.0–1.0 | Objective | 1 - clamp(avgLatency / targetLatency, 0, 1) |
| tokenCost | 0.0–1.0 | Objective | 1 - clamp(avgTokens / targetTokens, 0, 1) |

- **quality stays 0–5** for backward compatibility with existing feedback logic
- **Other dimensions are 0–1** — rates and normalized values
- **Latency target**: 2000ms default, per-skill override in SKILL.md
- **Token cost target**: 500 tokens default, per-skill override in SKILL.md

### Migration from Current Model

Current `ratings.json` entries have `{ skillName, rating, invocations, recentFeedback[] }`. Migration:
- `dimensions.quality` = existing `rating`
- `dimensions.completion` = 1.0 (assume success for historical data)
- `dimensions.reliability` = 1.0 (assume no errors for historical data)
- `dimensions.latency` = 0.5 (unknown, use neutral default)
- `dimensions.tokenCost` = 0.5 (unknown, use neutral default)
- `metrics` initialized from invocations count
- `source` added to existing feedback entries as `'unknown'`

## Composite Routing Score

Computed on-the-fly, never stored:

```
qualityNorm = dimensions.quality / 5.0

routingScore = w_completion * dimensions.completion
             + w_quality    * qualityNorm
             + w_reliability * dimensions.reliability
             + w_latency    * dimensions.latency
             + w_tokenCost  * dimensions.tokenCost
```

Result: 0.0–1.0. Higher is better.

### Task-Type Adaptive Weights

| Task Type | completion | quality | reliability | latency | tokenCost |
|-----------|-----------|---------|-------------|---------|-----------|
| one-shot (default) | 0.30 | 0.25 | 0.20 | 0.15 | 0.10 |
| long-running | 0.25 | 0.20 | 0.30 | 0.10 | 0.15 |
| agent-collab | 0.20 | 0.30 | 0.25 | 0.10 | 0.15 |

Rationale:
- **Long-running**: reliability matters most (crashes are costly)
- **Agent-collab**: quality matters most (output feeds other agents)

### Router Integration

Current: `cosine_similarity + (rating/5) * RATING_WEIGHT`
New: `cosine_similarity + routingScore * RATING_WEIGHT`

Same integration point, richer signal. The router determines task type from the query context (default: one-shot). Task type can be set explicitly via the API (`taskType` field in the request body) or inferred from the skill manifest (`taskType` field in SKILL.md frontmatter). If neither is specified, defaults to `one-shot`.

## Feedback Collection

### Two Signal Sources

#### 1. Explicit Feedback (Subjective → quality dimension)

From CLI, web, or API — thumbs up/down with optional comment:

```
POST /api/feedback
{
  "skillName": "weather",
  "positive": true,
  "comment": "accurate forecast",
  "source": "cli"
}
```

Quality update via EMA:
- Thumbs up: `quality += α * (5.0 - quality)` (moves toward 5.0)
- Thumbs down: `quality -= α * quality` (moves toward 0.0)
- α = 0.1 (same as current system)

#### 2. Auto-Collected Metrics (Objective → completion, reliability, latency, tokenCost)

Recorded on every skill invocation, no user action required:

```typescript
executor.recordInvocation({
  skillName: "weather",
  success: true,          // → completion
  error: null,            // → reliability
  latencyMs: 340,         // → latency
  tokenUsage: 120,        // → tokenCost
  taskType: "one-shot"    // for weight selection
});
```

Dimension updates:
- **completion**: totalSuccess / invocations (recalculated from counters)
- **reliability**: 1 - (totalErrors / invocations) (recalculated from counters)
- **latency**: 1 - clamp(avgLatency / targetLatency, 0, 1) (running average updated)
- **tokenCost**: 1 - clamp(avgTokens / targetTokens, 0, 1) (running average updated)

### Natural Language Feedback (for agent platforms)

In OpenClaw, Hermes, Claude Code, and other agent platforms, there is no thumbs-up button. Users express sentiment through natural language. Detection happens on the **first user message after skill output**.

**Two-layer detection:**

1. **Keyword match** (fast, free):
   - Positive patterns: `/great|perfect|thanks|exactly|works|helpful|awesome|correct|that's right|spot on/i`
   - Negative patterns: `/wrong|incorrect|bad|doesn't work|try again|not what|error|failed|useless|terrible|not helpful/i`
   - If keyword match → record feedback immediately

2. **LLM classification** (for ambiguous cases, optional):
   - If no keyword match, ask the LLM to classify sentiment + extract specific complaint
   - Can be disabled to save cost
   - Returns: `{ sentiment: "positive"|"negative"|"neutral", confidence: 0.85, comment: "wrong temperature unit" }`

**Guardrail**: Only the first user message after skill output is checked. If the user moves on to a different topic, no false feedback is recorded.

**All sources feed the same `recordFeedback()`** — whether from a thumbs-up button or NLP sentiment detection.

### Triggering Timing

| Trigger | When | What updates |
|---------|------|-------------|
| Auto-write | After every skill execution | completion, reliability, latency, tokenCost |
| Explicit | On user thumbs up/down | quality (EMA) |
| NLP detection | On first user message after skill output | quality (EMA) + comment stored |
| Batch recalc | On admin API call | All dimensions from raw metrics (useful after changing targets) |

## Scoring Synchronization

### Architecture: Local Truth + GitHub Gist Mirror

- **Local `ratings.json`** is the source of truth for all reads and writes
- **GitHub Gist** (private, per-user) is the cloud mirror for cross-device sync
- No separate server needed — GitHub API is the backend

### Gist Structure

```json
{
  "description": "AgentOctopus Ratings Sync",
  "files": {
    "ratings.json": { "content": "..." },
    "feedback-log.json": { "content": "..." },
    "sync-meta.json": { "content": "..." }
  },
  "public": false
}
```

- **ratings.json**: dimension scores + metrics per skill
- **feedback-log.json**: all feedback entries (including natural language comments) per skill
- **sync-meta.json**: lastSyncTimestamp, version, userId hash

### CLI Commands

| Command | Direction | Description |
|---------|-----------|-------------|
| `octopus sync --setup-gist` | setup | Create or find GitHub Gist, save gist ID locally |
| `octopus sync --ratings --pull` | cloud → local | Pull ratings + feedback from Gist, merge into local |
| `octopus sync --ratings --push` | local → cloud | Push local ratings + feedback to Gist |
| `octopus sync --ratings` | local ↔ cloud | Bidirectional: pull → merge → push |
| `octopus sync --ratings --pull --force` | cloud → local (overwrite) | Replace local with cloud data (no merge) |
| `octopus sync --ratings --dry-run` | preview | Show what would change without writing |
| `octopus sync --no-feedback-sharing` | privacy | Sync only scores, not feedback comments |

### Sync Protocol (pull → merge → push)

1. Read local gist ID from config
2. Fetch gist from GitHub API
3. For each skill in cloud data:
   - If local has no entry → use cloud data directly
   - If local is newer → skip (local wins)
   - If cloud is newer → merge into local
   - If both changed → merge (see conflict resolution)
4. Push local changes back to gist
5. Update lastSyncTimestamp

### Conflict Resolution

**Objective dimensions** (completion, reliability, latency, tokenCost):
- Merge by summing raw counters: `merged.totalSuccess = local.totalSuccess + cloud.totalSuccess`
- Latency/tokenCost: weighted average by invocation count
- No conflict possible — counters are additive

**Subjective dimension** (quality):
- Weighted average by feedback count:
  ```
  mergedQuality = (local.quality * local.feedbackCount + cloud.quality * cloud.feedbackCount)
                / (local.feedbackCount + cloud.feedbackCount)
  ```
- More feedback = more weight

**Feedback entries**: append new entries, deduplicate by feedback ID.

### Offline & Failure Compensation

| Scenario | Handling |
|----------|----------|
| Network down during push | Local write succeeds. Queue push for retry on next sync. No data loss. |
| Partial write | Cloud tracks lastSyncTimestamp per skill. Retry only failed skills. |
| Duplicate submission | Deduplicate by (skillName, timestamp). Safe to retry. |
| Cloud returns stale data | Local is source of truth. If local.lastModified > cloud.lastModified, local wins. |
| No GITHUB_TOKEN | Sync disabled, local-only mode. Everything still works. |
| Gist API rate limit | Debounced push (30s batch). Gist API allows 5000 req/hr. |

### Audit Trail

Every sync merge is logged to `ratings-sync-log.json` (last 100 entries):
```json
{
  "timestamp": "2026-04-17T02:30:00Z",
  "action": "merge",
  "skillName": "weather",
  "localQuality": 3.4,
  "cloudQuality": 3.8,
  "mergedQuality": 3.55,
  "localFeedbackCount": 10,
  "cloudFeedbackCount": 15
}
```

Gist revisions also provide a built-in version history.

## Author Feedback View

Skill authors query an aggregation endpoint to see cross-user feedback:

```
GET /api/skills/weather/feedback
```

Returns:
- Full dimension breakdown
- `feedbackSummary.totalFeedback` — total feedback count
- `feedbackSummary.positiveRate` — overall positive rate
- `feedbackSummary.bySource` — positive rate broken down by source platform
- `feedbackSummary.topComplaints` — most common negative comment topics
- `feedbackSummary.recentComments` — last N comments with sentiment, source, timestamp

In local-only mode, authors see only their own feedback. In cloud mode, the endpoint aggregates feedback from all synced users' gists.

**Privacy**: Author sees comments but not user identity. Users can opt out with `--no-feedback-sharing`.

## Data Flow

```
1. Generation  — Skill executes → auto-metrics recorded + user reacts → feedback recorded
2. Storage     — Dimensions updated in local ratings.json + feedback appended to recentFeedback[]
3. Sync        — Debounced push to Gist (ratings + feedback-log). Pull + merge on startup.
4. Aggregation — Cloud merges across users. Router computes routingScore from dimensions + task-type weights.
5. Presentation — CLI list shows ★ rating. Web shows dimension breakdown. Author API shows feedback + complaints.
```

## Presentation

### CLI (`octopus list`)
```
weather     ★★★☆☆ (3.1)  [completion: 92%]
translation ★★★☆☆ (3.0)  [completion: 90%]
ip-lookup   ★★★★☆ (4.6)  [completion: 95%]
```

### Web Dashboard
Shows dimension bars, positive rate, and recent feedback comments per skill.

### Author API
Full dimension breakdown, all feedback comments, positive rate by source, top complaints, trend direction.

## Scoring Examples

### Example 1: Comparing two translation skills

| Dimension | translation (free) | translation-pro (paid) |
|-----------|-------------------|----------------------|
| completion | 0.90 | 0.98 |
| quality | 3.2/5 = 0.64 | 4.5/5 = 0.90 |
| reliability | 0.88 | 0.99 |
| latency | 0.85 | 0.92 |
| tokenCost | 0.90 | 0.50 |
| **routingScore** | **0.80** | **0.89** |

translation-pro wins on quality/reliability. Author of free translation sees: "users complain about accuracy for Asian languages" → can improve.

### Example 2: Same skill, different task types

data-crawler skill with completion=0.75, quality=0.70, reliability=0.60, latency=0.50, tokenCost=0.40:
- one-shot weights → routingScore = 0.635
- long-running weights → routingScore = 0.610

Lower for long-running because reliability (0.60) is weighted more. Author sees: "high timeout rate in long crawls" → fix retry logic.

### Example 3: NLP feedback → quality score trace

```
Skill: weather, quality starts at 3.0

User (OpenClaw): "Perfect, thanks!"     → keyword: positive → quality: 3.2
User (Hermes):   "That's wrong"         → keyword: negative → quality: 2.88
User (CLI):      presses 👍             → explicit positive → quality: 3.09

Author sees: quality trending down, top complaint "wrong conditions for some cities" from Hermes
→ Action: improve weather data source for European cities
```

## Cross-Platform Extension Points

The `source` field on feedback entries enables future cross-platform collection:
- **OpenClaw**: feedback collected via NLP sentiment detection on agent conversations
- **Hermes**: same NLP approach
- **Claude Code**: same NLP approach
- **Web/CLI**: explicit thumbs up/down

All sources feed the same `recordFeedback()` with a `source` tag. The author feedback endpoint breaks down positive rate by source, so authors can see which platform's users are happiest.

## Out of Scope (Future Iterations)

- Full event sourcing / invocation log
- NLP sentiment detection via LLM (keyword-only in v1)
- Multi-user collaborative rating (beyond per-user Gist sync)
- Benchmarking / model comparison dashboards
- Per-skill latency/tokenCost target overrides in SKILL.md (use defaults in v1)
