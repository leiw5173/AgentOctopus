# How Routing Works

AgentOctopus routes natural-language queries to the best-matching skill through a multi-stage pipeline.

## Pipeline

```
Query → Language detection → Intent extraction → Eligibility filter → Embedding + Cosine → Keyword boost → LLM re-rank → Result or Fallback
```

### 1. Language detection

Non-English queries are auto-translated to English for routing accuracy. The original query is preserved for skill execution.

### 2. Intent extraction

The LLM distills the query to a short intent phrase (e.g., "shorten a URL", "get weather forecast"). This removes URLs, code snippets, and domain names so embeddings match purpose, not noise.

### 3. Eligibility filtering

`isSkillEligible()` applies hard keyword/regex filters per skill:

| Skill | Filter rule |
|---|---|
| `ip-lookup` | Query must contain an IPv4 address or domain name |
| `weather` | Query must contain weather keywords (weather, temperature, forecast, rain, etc.) |
| `translation` | Query must contain translate keywords or language names |
| All others | Pass through unconditionally |

### 4. Embedding + cosine similarity

The intent is embedded and compared against the skill index. Scores are weighted by `routingScore`:

```
score = cosine_similarity(query_embedding, skill_embedding) × routingScore - penalties
```

Penalties:
- **Negative feedback penalty** — skills with recent thumbs-down get demoted
- **Catch-all penalty** — skills with overly broad descriptions (e.g., "use for any request") get heavily penalized

### 5. Keyword boost

Skills whose names match query tokens get boosted into the candidate set even if cosine similarity missed them. Up to 5 name-matched skills are added.

### 6. LLM re-rank

Top candidates are sent to the LLM with a prompt that includes "none" as a valid answer. If "none" is returned or re-rank fails, `route()` returns an empty array.

### 7. Fallback

When `route()` returns `[]`, callers (web API, agent-protocol, IM bots) fall back to answering directly with the chat LLM.

## LLM-only mode

If embedding keys are omitted (`EMBED_PROVIDER`/`EMBED_API_KEY` not set), the router skips embedding entirely. All eligible skills go directly to LLM re-rank with keyword scoring.

See also: [Skills](skills.md) | [Rating System](ratings.md) | [How It Works](../introduction/how-it-works.md)
