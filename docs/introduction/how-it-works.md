# How It Works

AgentOctopus processes every query through a multi-stage pipeline that goes from natural language to a skill result.

## Request flow

```
User query
  → Gateway (CLI / REST API / IM bot / agent-protocol)
  → Router   — translates non-English, extracts intent,
               embeds query, cosine-scores against skill index,
               pre-filters with shouldIncludeSkill() from @agentoctopus/skills,
               LLM re-ranks, returns [] if no skill fits
  → Executor — applies env overrides from @agentoctopus/skills, picks adapter (inferred from directory contents), invokes skill
  → Result   — formatted, returned to caller; feedback updates ratings
```

## Routing stages

1. **Language detection** — non-English queries are auto-translated to English for routing, then the original query is preserved for skill execution
2. **Intent extraction** — the LLM distills the query to a short intent phrase (e.g., "shorten a URL") so embeddings match purpose, not noise
3. **Eligibility filtering** — `shouldIncludeSkill()` from `@agentoctopus/skills` evaluates each skill against its declared requirements (OS, binaries, env vars, config paths)
4. **Embedding + cosine similarity** — the intent is embedded and compared against the skill index; scores are weighted by `routingScore`
5. **Keyword boost** — skills whose names match query tokens get boosted even if cosine similarity missed them
6. **LLM re-rank** — top candidates are sent to the LLM for final selection; "none" is a valid answer
7. **Fallback** — if no skill matches, the query goes to the configured chat model directly

## Package structure

```
AgentOctopus/
├── apps/
│   ├── cli/           # CLI entry point
│   └── web/           # Next.js web UI + REST API
├── packages/
│   ├── agentoctopus/  # Umbrella package — re-exports everything
│   ├── core/          # Router + Executor + Planner + LLM client + ConfigResolver
│   ├── registry/      # Skill manifest loader + rating store
│   ├── adapters/      # HTTP, MCP stdio, subprocess adapters
│   └── gateway/       # IM bots + agent protocol + security
├── scripts/
│   └── build-skills-index.js   # Daily index builder
└── registry/
    ├── skills/        # Built-in SKILL.md manifests
    └── marketplace/   # Published skills + index.json
```

See also: [Routing](../core-concepts/routing.md) | [Skills](../core-concepts/skills.md) | [API Reference](../api-reference/rest-api.md)
