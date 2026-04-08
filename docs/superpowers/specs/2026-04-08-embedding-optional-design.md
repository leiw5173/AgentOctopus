# Embedding-Optional Router Design

## Goal

Make `octopus ask` work for OpenClaw users who have no embedding endpoint (e.g. OpenRouter users) by making the embedding phase optional in the router and falling back to LLM-only skill selection.

## Problem

`octopus ask` currently requires a working embedding endpoint at two points:
1. `router.buildIndex()` — embeds each skill description into a vector
2. `router.route()` — embeds the query and computes cosine similarity against the index

OpenClaw users typically use OpenRouter as their LLM provider. OpenRouter does not expose a native embedding endpoint. When `octopus connect openclaw` writes `EMBED_PROVIDER=openai` + `EMBED_BASE_URL=https://openrouter.ai/api/v1`, the embedding calls fail. The index is empty, `route()` returns `[]`, and `octopus ask` reports "No matching skill found" for every query.

Additionally, existing users who installed the skill before this fix need clear instructions on how to update.

## Scope

Changes to:
- `packages/core/src/router.ts` — make embedding optional in Router
- `packages/gateway/src/engine.ts` — pass optional embed config
- `apps/cli/src/index.ts` — pass optional embed config in bootstrap()
- `apps/cli/src/connect.ts` — skip EMBED_* keys for OpenRouter provider
- `registry/skills/agentoctopus-openclaw/SKILL.md` — add ## Updating section
- `README.md` — add update note in OpenClaw Integration section

No changes to: `invoke.js`, LLM re-rank logic, `SKILL.md` routing guidance, test infrastructure.

## Recommended Approach: LLM-only routing fallback

When no embed client is configured or embedding fails, the router skips the vector phase and passes all eligible skills directly to the existing LLM re-rank step. The LLM re-rank already returns the best skill name — it just normally operates on a pre-filtered top-K set from cosine scoring. In LLM-only mode it operates on the full eligible set instead.

This works cleanly because:
- Users typically have 3-10 skills installed — the LLM prompt stays small
- The LLM re-rank prompt already includes "none" as a valid answer, so no over-triggering
- The same LLM the user configured for chat handles routing — zero extra config

## Design Details

### 1. `packages/core/src/router.ts`

Make `embedConfig` optional in the constructor:

```typescript
constructor(chatConfig: LLMConfig, embedConfig?: LLMConfig) {
  this.chatClient = createChatClient(chatConfig);
  this.embedClient = embedConfig ? createEmbedClient(embedConfig) : null;
}
```

`embedClient` becomes `EmbedClient | null`.

`buildIndex()` — if `embedClient` is null, store skills with empty embeddings:
```typescript
async buildIndex(skills: LoadedSkill[]): Promise<void> {
  this.index = [];
  for (const skill of skills) {
    if (!this.embedClient) {
      this.index.push({ skill, embedding: [] });
      continue;
    }
    // existing embed logic...
  }
}
```

`route()` — if `embedClient` is null OR all embeddings are empty, skip cosine scoring and use all eligible skills as candidates for LLM re-rank:

```typescript
async route(query: string, topK = 3): Promise<RoutingResult[]> {
  const eligible = this.index.filter(({ skill }) => isSkillEligible(skill, query));
  if (eligible.length === 0) return [];

  let candidates: RoutingResultCandidate[];

  if (!this.embedClient || eligible.every(e => e.embedding.length === 0)) {
    // LLM-only mode: skip cosine scoring, use all eligible skills
    candidates = eligible.map(({ skill }) => ({ skill, score: 1.0 }));
  } else {
    // existing cosine scoring path...
    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.embedClient.embed(query);
    } catch (err) {
      // embed failed at runtime — fall back to LLM-only
      candidates = eligible.map(({ skill }) => ({ skill, score: 1.0 }));
    }
    // ... cosine scoring if queryEmbedding succeeded
  }

  // LLM re-rank (existing logic, unchanged)
  // ...
}
```

### 2. `packages/gateway/src/engine.ts`

The embed config is already conditionally constructed. Make it explicitly optional:

```typescript
const embedConfig: LLMConfig | undefined =
  process.env.EMBED_PROVIDER && process.env.EMBED_API_KEY
    ? { provider: embedProvider, model: ..., apiKey: ..., baseUrl: ... }
    : undefined;

const router = new Router(rerankConfig, embedConfig);
```

### 3. `apps/cli/src/index.ts` (bootstrap function)

Same pattern — only build `embedConfig` if env vars are present:

```typescript
const embedConfig: LLMConfig | undefined =
  process.env.EMBED_PROVIDER && process.env.EMBED_API_KEY
    ? { provider: embedProvider, model: ..., apiKey: ..., baseUrl: ... }
    : undefined;

const router = new Router(chatConfig, embedConfig);
```

### 4. `apps/cli/src/connect.ts`

When the provider is `openrouter`, do not write `EMBED_*` credentials. OpenRouter has no embedding endpoint, so writing them creates a broken config that causes silent failures:

```typescript
// Only write EMBED_* keys for providers that support embedding
const supportsEmbedding = (provider: string) =>
  provider !== 'openrouter';

if (supportsEmbedding(entry.provider)) {
  credentials['EMBED_PROVIDER'] = extracted.provider;
  credentials['EMBED_MODEL'] = embedModelDefaults[extracted.provider] ?? 'text-embedding-3-small';
  credentials['EMBED_API_KEY'] = extracted.apiKey;
  credentials['EMBED_BASE_URL'] = extracted.baseUrl;
}
// If not supported, EMBED_* keys are absent → LLM-only routing path triggers automatically
```

Also update the output message to tell users which mode they're in:
```
  Routing mode: LLM-only (OpenRouter does not support embeddings)
```
or:
```
  Routing mode: Embedding + LLM re-rank
```

### 5. `registry/skills/agentoctopus-openclaw/SKILL.md`

Add a `## Updating` section at the end of the file:

```markdown
## Updating

To update an existing installation:

```bash
clawhub update agentoctopus
npm update -g agentoctopus
octopus connect openclaw
```
```

### 6. `README.md`

In the `## OpenClaw Integration` section, add an update subsection after the initial install instructions:

```markdown
### Updating an existing install

```bash
clawhub update agentoctopus
npm update -g agentoctopus
octopus connect openclaw   # re-run to refresh config
```
```

## Data Flow: LLM-only mode

```
octopus ask "translate hello to French"
  → bootstrap(): EMBED_PROVIDER absent → embedConfig = undefined
  → Router(chatConfig, undefined) → embedClient = null
  → router.buildIndex(skills): embedClient null → all skills stored with embedding: []
  → router.route("translate hello to French"):
      eligible = skills passing isSkillEligible() filter
      embedClient null → skip cosine scoring
      candidates = all eligible skills with score 1.0
      LLM re-rank: "Given [weather, translation, ip-lookup], which fits 'translate hello to French'?" → "translation"
      return RoutingResult for translation skill
  → executor.execute(translation, { query })
  → "Bonjour"
```

## Data Flow: Embedding mode (unchanged for non-OpenRouter users)

```
octopus ask "translate hello to French"
  → bootstrap(): EMBED_PROVIDER set → embedConfig built
  → Router(chatConfig, embedConfig) → embedClient = OpenAIEmbedClient
  → router.buildIndex(skills): embeds each skill description
  → router.route(): embeds query, cosine scores, top-K → LLM re-rank
  → result
```

## Validation

After changes, verify:

1. **OpenRouter user (no EMBED_* in octopus.json):**
   - `octopus connect openclaw` does not write EMBED_* keys
   - `octopus ask "translate hello to French"` returns correct result
   - No "Failed to embed" error in output

2. **OpenAI user (EMBED_* present):**
   - `octopus connect openclaw` still writes EMBED_* keys
   - Embedding path runs as before
   - All existing tests pass

3. **Existing installed skill users:**
   - `## Updating` section visible in SKILL.md
   - README update note present

## Files Affected

| File | Change |
|---|---|
| `packages/core/src/router.ts` | `embedConfig` optional, LLM-only fallback in `route()` |
| `packages/gateway/src/engine.ts` | Conditional `embedConfig` construction |
| `apps/cli/src/index.ts` | Conditional `embedConfig` in `bootstrap()` |
| `apps/cli/src/connect.ts` | Skip `EMBED_*` for OpenRouter, show routing mode |
| `registry/skills/agentoctopus-openclaw/SKILL.md` | Add `## Updating` section |
| `README.md` | Add update instructions in OpenClaw Integration section |
