import type { LoadedSkill } from '@agentoctopus/registry';
import { type ChatClient, type EmbedClient, type LLMConfig, createChatClient, createEmbedClient, skillToText } from './llm-client.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';

export interface RoutingResult {
  skill: LoadedSkill;
  score: number;
  confidence: number; // 0-1 normalized confidence
  reason: string;
}

const RATING_WEIGHT = 0.35;
const FAILURE_PENALTY = 0.50; // per negative feedback — must overcome keyword score advantages
const CATCHALL_PENALTY = 2.0;  // penalty for skills with overly broad "catch-all" descriptions
const LLM_RERANK_CAP = 20;    // max candidates sent to LLM reranker
const IP_ADDRESS_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/;
const DOMAIN_PATTERN = /\b(?=.{1,253}\b)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/i;
const WEATHER_KEYWORDS = /\b(weather|temperature|forecast|rain|snow|wind|humidity|sunny|cloudy|storm|climate)\b/i;
const TRANSLATION_KEYWORDS = /\b(translate|translation|in\s+(french|spanish|japanese|chinese|english|german|italian|portuguese|korean|arabic|russian)|to\s+(french|spanish|japanese|chinese|english|german|italian|portuguese|korean|arabic|russian))\b/i;

// Skills with catch-all descriptions that match everything should be penalized.
// These patterns identify descriptions designed to intercept all queries.
const CATCHALL_PATTERN = /\b(any time the user|whenever the user|any request|use this skill for any|regardless of|even if.*not.*mention|but is not limited to|any.*question|any.*task|any.*query)\b/i;

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// CJK character range detection (Chinese, Japanese, Korean)
const CJK_RANGE = /[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

/**
 * Extract meaningful query tokens. For Latin text, splits on word boundaries
 * and filters short words. For CJK text, keeps individual characters.
 * Non-English queries should be pre-translated before calling this.
 */
function extractQueryTokens(query: string): string[] {
  const lower = query.toLowerCase();
  const tokens: string[] = [];

  // Extract Latin words (3+ chars)
  const latinWords = lower.match(/[a-z]{3,}/g) ?? [];
  tokens.push(...latinWords);

  // Extract CJK characters as individual tokens (each char is meaningful)
  const cjkChars = lower.match(/[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff]/g) ?? [];
  tokens.push(...cjkChars);

  return [...new Set(tokens)];
}

/**
 * Detect if a query contains non-Latin characters (CJK, Cyrillic, Arabic, etc.)
 */
function hasNonLatinChars(query: string): boolean {
  return /[^\x00-\x7F]/.test(query.replace(/\s/g, ''));
}

/**
 * Score how well a skill matches query tokens. Uses word-boundary-start
 * prefix matching for Latin words — token must start at a word boundary but
 * can be a prefix of a longer word. This allows "short" to match "shorten",
 * "shortlink", "shortener" while still preventing "link" from matching
 * "blinker". For CJK characters, checks direct inclusion since CJK doesn't
 * have word boundaries.
 * Returns a score where name matches are weighted higher than description matches.
 */
function scoreKeywordMatch(tokens: string[], skill: LoadedSkill): number {
  const name = skill.manifest.name.toLowerCase();
  const desc = skill.manifest.description.toLowerCase();
  const tags = skill.manifest.tags.join(' ').toLowerCase();

  let score = 0;
  for (const token of tokens) {
    if (CJK_RANGE.test(token)) {
      // CJK: direct inclusion is fine (each char is a word)
      if (name.includes(token)) score += 2;      // name match = 2x weight
      else if (desc.includes(token)) score += 1;
      else if (tags.includes(token)) score += 1;
    } else {
      // Latin: word-boundary-start prefix matching
      // \bshort matches "short", "shorten", "shortlink", "shortener"
      // but "link" won't match "blinker" (no word boundary before "link" in "blinker")
      const pattern = new RegExp(`\\b${token}`, 'i');
      if (pattern.test(name)) score += 2;         // name match = 2x weight
      else if (pattern.test(desc)) score += 1;
      else if (pattern.test(tags)) score += 1;
    }
  }
  return score;
}

/**
 * Detect if a skill has a "catch-all" description designed to match everything.
 */
function isCatchAllSkill(skill: LoadedSkill): boolean {
  const desc = skill.manifest.description;
  if (CATCHALL_PATTERN.test(desc)) return true;
  // Very long descriptions (>300 chars) with many trigger phrases are suspicious
  if (desc.length > 300 && (desc.match(/\buse when\b/gi) || []).length >= 3) return true;
  return false;
}

interface VectorEntry {
  skill: LoadedSkill;
  embedding: number[];
}

interface EmbedCacheFile {
  model: string;
  skills: Record<string, { hash: string; embedding: number[] }>;
}

function isSkillEligible(skill: LoadedSkill, query: string): boolean {
  const normalizedQuery = query.trim();
  const skillName = skill.manifest.name.toLowerCase();

  if (skillName === 'ip-lookup') {
    return IP_ADDRESS_PATTERN.test(normalizedQuery) || DOMAIN_PATTERN.test(normalizedQuery);
  }

  if (skillName === 'weather') {
    return WEATHER_KEYWORDS.test(normalizedQuery);
  }

  if (skillName === 'translation') {
    return TRANSLATION_KEYWORDS.test(normalizedQuery);
  }

  // HTTP-adapter skills with no endpoint can still be executed via
  // LLM-guided execution (the LLM reads SKILL.md to determine the API call).
  // Don't hard-filter them out — the LLM re-rank will handle relevance.

  return true;
}

function parseRerankDecision(response: string, candidates: RoutingResultCandidate[]): string | 'none' {
  const normalized = response.trim().toLowerCase();

  if (!normalized) return 'none';
  if (normalized === 'none' || /\bnone\b/.test(normalized)) return 'none';

  const exactMatch = candidates.find((candidate) => candidate.skill.manifest.name.toLowerCase() === normalized);
  if (exactMatch) return exactMatch.skill.manifest.name.toLowerCase();

  const mentionedMatch = candidates.find((candidate) => normalized.includes(candidate.skill.manifest.name.toLowerCase()));
  if (mentionedMatch) return mentionedMatch.skill.manifest.name.toLowerCase();

  return 'none';
}

interface RoutingResultCandidate {
  skill: LoadedSkill;
  score: number;
}

export class Router {
  private index: VectorEntry[] = [];
  private chatClient: ChatClient;
  private embedClient: EmbedClient | null;
  private embedModel: string;

  constructor(chatConfig: LLMConfig, embedConfig?: LLMConfig) {
    this.chatClient = createChatClient(chatConfig);
    this.embedClient = embedConfig ? createEmbedClient(embedConfig) : null;
    this.embedModel = embedConfig?.model ?? '';
  }

  private embedCachePath(): string {
    return path.join(os.homedir(), '.agentoctopus', 'embed-cache.json');
  }

  private skillContentHash(skill: LoadedSkill): string {
    return createHash('sha1').update(skillToText(skill)).digest('hex').slice(0, 12);
  }

  private loadEmbedCacheFile(): EmbedCacheFile | null {
    try {
      const cachePath = this.embedCachePath();
      if (!fs.existsSync(cachePath)) return null;
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as EmbedCacheFile;
      if (raw.model !== this.embedModel) return null;
      return raw;
    } catch {
      return null;
    }
  }

  private saveEmbedCacheFile(cache: EmbedCacheFile): void {
    try {
      const cachePath = this.embedCachePath();
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(cache));
    } catch {
      // cache write failure is non-fatal
    }
  }

  /**
   * Look up a single skill's embedding from the per-skill cache.
   * Returns null if not cached or if the skill content has changed.
   */
  private getCachedEmbedding(cache: EmbedCacheFile | null, skill: LoadedSkill): number[] | null {
    if (!cache) return null;
    const entry = cache.skills[skill.manifest.name];
    if (!entry) return null;
    if (entry.hash !== this.skillContentHash(skill)) return null;
    return entry.embedding;
  }

  async buildIndex(skills: LoadedSkill[]): Promise<void> {
    this.index = [];

    if (!this.embedClient) {
      // No embed client — store skills without embeddings, route() will use keyword-only
      this.index = skills.map(skill => ({ skill, embedding: [] }));
      return;
    }

    // For small registries, pre-compute all embeddings upfront (cached to disk)
    const SMALL_REGISTRY_THRESHOLD = 500;
    if (skills.length <= SMALL_REGISTRY_THRESHOLD) {
      const cache = this.loadEmbedCacheFile();
      const allCached = cache && skills.every(s => this.getCachedEmbedding(cache, s) !== null);

      if (allCached) {
        this.index = skills.map(skill => ({
          skill,
          embedding: this.getCachedEmbedding(cache!, skill) ?? [],
        }));
        return;
      }

      // Embed all skills in parallel and save
      const EMBED_CONCURRENCY = 16;
      const newCache: EmbedCacheFile = { model: this.embedModel, skills: cache?.skills ?? {} };
      const entries: VectorEntry[] = new Array(skills.length);

      let nextIdx = 0;
      const worker = async () => {
        while (nextIdx < skills.length) {
          const idx = nextIdx++;
          const skill = skills[idx]!;
          const cached = this.getCachedEmbedding(cache, skill);
          if (cached) {
            entries[idx] = { skill, embedding: cached };
          } else {
            try {
              const embedding = await this.embedClient!.embed(skillToText(skill));
              entries[idx] = { skill, embedding };
              newCache.skills[skill.manifest.name] = {
                hash: this.skillContentHash(skill),
                embedding,
              };
            } catch {
              entries[idx] = { skill, embedding: [] };
            }
          }
        }
      };

      await Promise.all(Array.from({ length: EMBED_CONCURRENCY }, worker));
      this.index = entries;
      this.saveEmbedCacheFile(newCache);
      return;
    }

    // Large registry — store skills without embeddings.
    // route() will use the two-tier hybrid path: keyword pre-filter → on-demand embed.
    this.index = skills.map(skill => ({ skill, embedding: [] }));
  }

  async route(query: string, topK = 10): Promise<RoutingResult[]> {
    if (this.index.length === 0) return [];

    // Translate non-English queries to English for keyword matching against English skill descriptions
    let routingQuery = query;
    if (hasNonLatinChars(query)) {
      try {
        const translated = await this.chatClient.chat(
          'Translate the following to English. Output ONLY the translation, nothing else. Preserve any URLs or technical terms as-is.',
          query,
        );
        const trimmed = translated.trim();
        if (trimmed) {
          // Combine original + translation for maximum token coverage
          routingQuery = `${query} ${trimmed}`;
        }
      } catch {
        // Translation failed — proceed with original query
      }
    }

    const eligible = this.index.filter(({ skill }) => isSkillEligible(skill, routingQuery));
    if (eligible.length === 0) return [];

    let candidates: RoutingResultCandidate[];

    const hasPrecomputedEmbeddings = eligible.some(e => e.embedding.length > 0);

    if (hasPrecomputedEmbeddings) {
      // PATH A: Small registry — all embeddings pre-computed in buildIndex()
      let queryEmbedding: number[] = [];
      try {
        queryEmbedding = await this.embedClient!.embed(routingQuery);
      } catch (err) {
        console.warn(`[Router] Failed to embed query, falling back to keyword-only: ${(err as Error).message || err}`);
      }

      if (queryEmbedding.length > 0) {
        const scored = eligible.map(({ skill, embedding }) => {
          const cosine = cosineSimilarity(queryEmbedding, embedding);
          const routingScore = skill.routingScore ?? (skill.rating / 5);
          const ratingBoost = routingScore * RATING_WEIGHT;
          const negCount = skill.negativeFeedbackCount ?? 0;
          const penalty = negCount * FAILURE_PENALTY;
          const catchAllPenalty = isCatchAllSkill(skill) ? CATCHALL_PENALTY * 0.1 : 0;
          return { skill, score: cosine + ratingBoost - penalty - catchAllPenalty };
        });
        scored.sort((a, b) => b.score - a.score);
        candidates = scored.slice(0, topK);
      } else {
        candidates = eligible.map(({ skill }) => ({ skill, score: 1.0 }));
      }
    } else if (this.embedClient) {
      // PATH B: Large registry with embed client — two-tier hybrid
      // Step 1: Keyword pre-filter to narrow from thousands to ~50
      const KEYWORD_PREFILTER_CAP = 50;
      const tokens = extractQueryTokens(routingQuery);
      const keywordScored = eligible.map(({ skill }) => {
        const keywordHits = scoreKeywordMatch(tokens, skill);
        const routingScore = skill.routingScore ?? (skill.rating / 5);
        const ratingBoost = routingScore * RATING_WEIGHT;
        const negCount = skill.negativeFeedbackCount ?? 0;
        const penalty = negCount * FAILURE_PENALTY;
        const catchAllPenalty = isCatchAllSkill(skill) ? CATCHALL_PENALTY : 0;
        return { skill, keywordHits, score: keywordHits + ratingBoost - penalty - catchAllPenalty };
      });
      keywordScored.sort((a, b) => b.score - a.score);
      const withHits = keywordScored.filter(s => s.keywordHits > 0);
      const prefiltered = (withHits.length > 0 ? withHits : keywordScored).slice(0, KEYWORD_PREFILTER_CAP);

      // Step 2: Embed query + candidates on-demand (with per-skill cache)
      let queryEmbedding: number[] = [];
      try {
        queryEmbedding = await this.embedClient.embed(routingQuery);
      } catch (err) {
        console.warn(`[Router] Failed to embed query, falling back to keyword-only: ${(err as Error).message || err}`);
      }

      if (queryEmbedding.length > 0) {
        // Embed candidates in parallel, using cache where possible
        const cache = this.loadEmbedCacheFile();
        const newCache: EmbedCacheFile = { model: this.embedModel, skills: cache?.skills ?? {} };
        const EMBED_CONCURRENCY = 16;

        type ScoredCandidate = { skill: LoadedSkill; embedding: number[] };
        const embedded: ScoredCandidate[] = new Array(prefiltered.length);
        let nextIdx = 0;
        let cacheUpdated = false;

        const worker = async () => {
          while (nextIdx < prefiltered.length) {
            const idx = nextIdx++;
            const skill = prefiltered[idx]!.skill;
            const cached = this.getCachedEmbedding(cache, skill);
            if (cached) {
              embedded[idx] = { skill, embedding: cached };
            } else {
              try {
                const embedding = await this.embedClient!.embed(skillToText(skill));
                embedded[idx] = { skill, embedding };
                newCache.skills[skill.manifest.name] = {
                  hash: this.skillContentHash(skill),
                  embedding,
                };
                cacheUpdated = true;
              } catch {
                embedded[idx] = { skill, embedding: [] };
              }
            }
          }
        };

        await Promise.all(Array.from({ length: Math.min(EMBED_CONCURRENCY, prefiltered.length) }, worker));

        if (cacheUpdated) {
          this.saveEmbedCacheFile(newCache);
        }

        // Step 3: Cosine rank the embedded candidates
        const cosineScored = embedded
          .filter(e => e.embedding.length > 0)
          .map(({ skill, embedding }) => {
            const cosine = cosineSimilarity(queryEmbedding, embedding);
            const routingScore = skill.routingScore ?? (skill.rating / 5);
            const ratingBoost = routingScore * RATING_WEIGHT;
            const negCount = skill.negativeFeedbackCount ?? 0;
            const penalty = negCount * FAILURE_PENALTY;
            const catchAllPenalty = isCatchAllSkill(skill) ? CATCHALL_PENALTY * 0.1 : 0;
            return { skill, score: cosine + ratingBoost - penalty - catchAllPenalty };
          });
        cosineScored.sort((a, b) => b.score - a.score);
        candidates = cosineScored.slice(0, LLM_RERANK_CAP);
      } else {
        // Embedding failed — fall back to keyword-scored candidates
        candidates = prefiltered.slice(0, LLM_RERANK_CAP);
      }
    } else {
      // PATH C: No embed client — keyword-only
      const tokens = extractQueryTokens(routingQuery);
      const scored = eligible.map(({ skill }) => {
        const keywordHits = scoreKeywordMatch(tokens, skill);
        const routingScore = skill.routingScore ?? (skill.rating / 5);
        const ratingBoost = routingScore * RATING_WEIGHT;
        const negCount = skill.negativeFeedbackCount ?? 0;
        const penalty = negCount * FAILURE_PENALTY;
        const catchAllPenalty = isCatchAllSkill(skill) ? CATCHALL_PENALTY : 0;
        return { skill, keywordHits, score: keywordHits + ratingBoost - penalty - catchAllPenalty };
      });
      scored.sort((a, b) => b.score - a.score);
      const withHits = scored.filter(s => s.keywordHits > 0);
      candidates = (withHits.length > 0 ? withHits : scored).slice(0, LLM_RERANK_CAP);
    }

    if (candidates.length === 0) return [];

    const candidateList = candidates
      .map((c, i) => {
        const neg = c.skill.negativeFeedbackCount ?? 0;
        const ratingNote = neg > 0 ? ` [⚠ ${neg} negative feedback${neg > 1 ? 's' : ''}]` : '';
        // Truncate long descriptions to keep the rerank prompt focused
        let desc = c.skill.manifest.description;
        if (desc.length > 120) desc = desc.slice(0, 120) + '…';
        return `${i + 1}. ${c.skill.manifest.name}: ${desc}${ratingNote}`;
      })
      .join('\n');

    const systemPrompt = `You are a routing assistant. Given a user request and a list of candidate skills, pick the single best skill that SPECIFICALLY handles the user's request. Follow these rules:

1. Match the skill's PRIMARY purpose to the user's intent — ignore skills that only tangentially relate.
2. "URL shortening" ≠ "web hosting" ≠ "link sharing". Be precise about what the skill does.
3. Skills marked with ⚠ have received negative user feedback — strongly prefer alternatives.
4. Skills with very broad descriptions ("any request", "any task") are LESS likely to be correct — prefer specific skills.
5. Respond "none" if no skill is a genuine match for what the user is asking.

Respond with ONLY the skill name (exactly as listed) or "none", nothing else.`;
    const userMessage = `User request: "${query}"\n\nCandidates:\n${candidateList}\n\nBest skill (or "none" if no skill fits):`;

    let bestSkillName: string;
    try {
      bestSkillName = parseRerankDecision(await this.chatClient.chat(systemPrompt, userMessage), candidates);
    } catch (err) {
      console.warn(`[Router] LLM re-rank failed, returning no skill: ${(err as Error).message || err}`);
      bestSkillName = 'none';
    }

    // LLM decided no skill fits
    if (bestSkillName === 'none') return [];

    const best = candidates.find(
      (c) => c.skill.manifest.name.toLowerCase() === bestSkillName,
    );
    if (!best) return [];

    return [
      {
        skill: best.skill,
        score: best.score,
        confidence: normalizeConfidence(best.score),
        reason: `Selected "${best.skill.manifest.name}" as the best match for your request.`,
      },
    ];
  }
}

/**
 * Normalize a raw routing score (cosine + rating boost) to a 0-1 confidence value.
 * Cosine similarity ranges roughly 0.3-0.9 for relevant matches; rating boost adds up to 0.15.
 * We map the practical range [0.3, 1.0] → [0.0, 1.0] with clamping.
 */
function normalizeConfidence(rawScore: number): number {
  const MIN_SCORE = 0.3;
  const MAX_SCORE = 1.0;
  const normalized = (rawScore - MIN_SCORE) / (MAX_SCORE - MIN_SCORE);
  return Math.max(0, Math.min(1, Math.round(normalized * 100) / 100));
}
