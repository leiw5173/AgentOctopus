import type { LoadedSkill } from '@agentoctopus/registry';
import { getRequiredEnvVars, getRequiredBins } from '@agentoctopus/registry';
import { type ChatClient, type EmbedClient, type LLMConfig, createChatClient, createEmbedClient, skillToText } from './llm-client.js';
import { isBinAvailable } from './utils.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { dbg } from './debug.js';

export interface RoutingResult {
  skill: LoadedSkill;
  score: number;
  confidence: number; // 0-1 normalized confidence
  reason: string;
}

const RATING_WEIGHT = 0.35;
const FAILURE_PENALTY = 0.50; // per negative feedback — must overcome keyword score advantages
const CATCHALL_PENALTY = 2.0;  // penalty for skills with overly broad "catch-all" descriptions
const LLM_RERANK_CAP = 10;    // max candidates sent to LLM reranker
const RELIABILITY_FLOOR = 0.1; // minimum routingScore multiplier — even broken skills get a small chance
const IP_ADDRESS_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/;
const DOMAIN_PATTERN = /\b(?=.{1,253}\b)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/i;
const WEATHER_KEYWORDS = /\b(weather|temperature|forecast|rain|snow|wind|humidity|sunny|cloudy|storm|climate)\b/i;
const TRANSLATION_KEYWORDS = /\b(translate|translation|in\s+(french|spanish|japanese|chinese|english|german|italian|portuguese|korean|arabic|russian)|to\s+(french|spanish|japanese|chinese|english|german|italian|portuguese|korean|arabic|russian))\b/i;

// Skills with catch-all descriptions that match everything should be penalized.
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
 */
function extractQueryTokens(query: string): string[] {
  const lower = query.toLowerCase();
  const tokens: string[] = [];
  const latinWords = lower.match(/[a-z]{3,}/g) ?? [];
  tokens.push(...latinWords);
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
 * "blinker". For CJK characters, checks direct inclusion.
 */
function scoreKeywordMatch(tokens: string[], skill: LoadedSkill): number {
  const name = skill.manifest.name.toLowerCase();
  const desc = skill.manifest.description.toLowerCase();
  const tags = skill.manifest.tags.join(' ').toLowerCase();

  let score = 0;
  for (const token of tokens) {
    if (CJK_RANGE.test(token)) {
      if (name.includes(token)) score += 2;
      else if (desc.includes(token)) score += 1;
      else if (tags.includes(token)) score += 1;
    } else {
      const pattern = new RegExp(`\\b${token}`, 'i');
      if (pattern.test(name)) score += 2;
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

export function isSkillEligible(skill: LoadedSkill, query: string): boolean {
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

  // Filter out http/no-endpoint skills that have zero keyword relevance to the query.
  // These skills can only be executed via LLM-guided curl, and if they have no keyword
  // overlap with the query they are almost certainly irrelevant noise.
  if (
    skill.manifest.adapter === 'http' &&
    !skill.manifest.endpoint &&
    !skill.manifest.llm_powered
  ) {
    const words = normalizedQuery.toLowerCase().split(/\W+/).filter(w => w.length > 2);
    const haystack = (
      skill.manifest.name + ' ' +
      skill.manifest.description + ' ' +
      skill.manifest.tags.join(' ')
    ).toLowerCase();
    const hasAnyMatch = words.some(w => haystack.includes(w));
    if (!hasAnyMatch) return false;
  }

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

  private getCachedEmbedding(cache: EmbedCacheFile | null, skill: LoadedSkill): number[] | null {
    if (!cache) return null;
    const entry = cache.skills[skill.manifest.name];
    if (!entry) return null;
    if (entry.hash !== this.skillContentHash(skill)) return null;
    return entry.embedding;
  }

  /**
   * Build the skill index by embedding all skills. Uses per-skill disk cache
   * so subsequent runs are instant — only new/changed skills need embedding.
   * First run with 4000+ skills takes time, but cache makes it fast after.
   */
  async buildIndex(skills: LoadedSkill[], opts: { debug?: boolean } = {}): Promise<void> {
    const { debug = false } = opts;
    const t0 = Date.now();
    dbg(debug, `Registry: ${skills.length} skill(s) loaded`);
    this.index = [];

    if (!this.embedClient) {
      this.index = skills.map(skill => ({ skill, embedding: [] }));
      return;
    }

    const cache = this.loadEmbedCacheFile();
    const newCache: EmbedCacheFile = { model: this.embedModel, skills: cache?.skills ?? {} };
    const entries: VectorEntry[] = new Array(skills.length);
    let nextIdx = 0;
    let cacheUpdated = false;
    let embeddedCount = 0;
    let cachedCount = 0;

    const EMBED_CONCURRENCY = 16;
    const worker = async () => {
      while (nextIdx < skills.length) {
        const idx = nextIdx++;
        const skill = skills[idx]!;
        const cached = this.getCachedEmbedding(cache, skill);
        if (cached) {
          entries[idx] = { skill, embedding: cached };
          cachedCount++;
        } else {
          try {
            const embedding = await this.embedClient!.embed(skillToText(skill));
            entries[idx] = { skill, embedding };
            newCache.skills[skill.manifest.name] = {
              hash: this.skillContentHash(skill),
              embedding,
            };
            cacheUpdated = true;
            embeddedCount++;
          } catch {
            entries[idx] = { skill, embedding: [] };
          }
        }
      }
    };

    await Promise.all(Array.from({ length: EMBED_CONCURRENCY }, worker));
    this.index = entries;

    if (cacheUpdated) {
      this.saveEmbedCacheFile(newCache);
    }

    dbg(debug, `Embedding index built: ${cachedCount} cached + ${embeddedCount} newly embedded (${Date.now() - t0}ms)`);
  }

  /**
   * Route a query to the best skill.
   * Flow: translate → eligibility filter → embed query → cosine × routingScore → top K → LLM rerank
   */
  async route(query: string, topK = 20, opts: { debug?: boolean } = {}): Promise<RoutingResult[]> {
    const { debug = false } = opts;
    if (this.index.length === 0) return [];

    // Translate non-English queries to English
    let routingQuery = query;
    if (hasNonLatinChars(query)) {
      try {
        const translated = await this.chatClient.chat(
          'Translate the following to English. Output ONLY the translation, nothing else. Preserve any URLs or technical terms as-is.',
          query,
        );
        const trimmed = translated.trim();
        if (trimmed) {
          routingQuery = `${query} ${trimmed}`;
        }
      } catch {
        // Translation failed — proceed with original query
      }
    }

    const eligible: VectorEntry[] = [];
    for (const entry of this.index) {
      const pass = isSkillEligible(entry.skill, routingQuery);
      dbg(debug, `isSkillEligible: ${entry.skill.manifest.name} → ${pass ? 'PASS' : 'SKIP'}`);
      if (pass) eligible.push(entry);
    }
    if (eligible.length === 0) return [];

    // Extract the user's intent for embedding matching.
    // This distills noisy queries (URLs, code, domain names) into a clean
    // intent phrase, so embeddings match the *purpose* not the noise.
    // e.g. "make this link as short link: https://clawhub.ai/..." → "shorten a URL"
    let embedQuery = routingQuery;
    try {
      const intent = await this.chatClient.chat(
        'Extract the user\'s core intent from this request. Output ONLY a short phrase describing what they want to do (e.g. "shorten a URL", "get weather forecast", "translate text to French"). Remove URLs, code snippets, and domain names. Do not explain, just output the intent.',
        routingQuery,
      );
      const trimmed = intent.trim();
      if (trimmed && trimmed.length < routingQuery.length) {
        embedQuery = trimmed;
      }
    } catch {
      // Intent extraction failed — use full query for embedding
    }

    let candidates: RoutingResultCandidate[];
    const hasEmbeddings = eligible.some(e => e.embedding.length > 0);

    if (hasEmbeddings && this.embedClient) {
      // Embedding path: embed intent → cosine × routingScore → top K
      let queryEmbedding: number[] = [];
      try {
        queryEmbedding = await this.embedClient.embed(embedQuery);
      } catch (err) {
        console.warn(`[Router] Failed to embed query, falling back to keyword-only: ${(err as Error).message || err}`);
      }

      if (queryEmbedding.length > 0) {
        const scored = eligible
          .filter(e => e.embedding.length > 0)
          .map(({ skill, embedding }) => {
            const cosine = cosineSimilarity(queryEmbedding, embedding);
            const routingScore = Math.max(RELIABILITY_FLOOR, skill.routingScore ?? (skill.rating / 5));
            const negCount = skill.negativeFeedbackCount ?? 0;
            const penalty = negCount * FAILURE_PENALTY;
            const catchAllPenalty = isCatchAllSkill(skill) ? CATCHALL_PENALTY * 0.1 : 0;
            return { skill, score: cosine * routingScore - penalty - catchAllPenalty };
          });
        scored.sort((a, b) => b.score - a.score);

        dbg(debug, `Cosine scores (top ${Math.min(5, scored.length)}):`);
        for (const s of scored.slice(0, 5)) {
          const rs = Math.max(RELIABILITY_FLOOR, s.skill.routingScore ?? (s.skill.rating / 5));
          dbg(debug, `  ${s.skill.manifest.name.padEnd(20)} score=${s.score.toFixed(3)}  routingScore=${rs.toFixed(3)}`);
        }

        // Take top K by cosine, but also boost in skills with strong keyword matches
        // that may have been missed by embedding similarity.
        // Only boost skills where the query matches the skill NAME (not just description),
        // since name matches are much more specific and less noisy.
        const cosineTop = scored.slice(0, topK);
        const tokens = extractQueryTokens(routingQuery);
        const keywordBoosted = scored
          .filter(s => !cosineTop.some(c => c.skill.manifest.name === s.skill.manifest.name))
          .filter(s => {
            // Require at least one token to match the skill name (prefix match)
            const name = s.skill.manifest.name.toLowerCase();
            return tokens.some(t => {
              if (CJK_RANGE.test(t)) return name.includes(t);
              return new RegExp(`\\b${t}`, 'i').test(name);
            });
          })
          .slice(0, 5); // up to 5 name-matched skills
        candidates = [...cosineTop, ...keywordBoosted];
      } else {
        candidates = this.keywordFallback(eligible, routingQuery);
      }
    } else {
      candidates = this.keywordFallback(eligible, routingQuery);
    }

    if (candidates.length === 0) return [];

    candidates = this.penalizeUnconfiguredSkills(candidates);

    // LLM rerank
    const candidateList = candidates
      .map((c, i) => {
        const neg = c.skill.negativeFeedbackCount ?? 0;
        const ratingNote = neg > 0 ? ` [⚠ ${neg} negative feedback${neg > 1 ? 's' : ''}]` : '';
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
      dbg(debug, `Reranker prompt sent (${candidates.length} candidate(s) + "none")`);
      const rawRerankerResponse = await this.chatClient.chat(systemPrompt, userMessage);
      dbg(debug, `Reranker raw response: "${rawRerankerResponse.trim()}"`);
      bestSkillName = parseRerankDecision(rawRerankerResponse, candidates);
      const chosenEntry = candidates.find(c => c.skill.manifest.name.toLowerCase() === bestSkillName);
      const decisionConfidence = chosenEntry ? normalizeConfidence(chosenEntry.score) : 0;
      dbg(debug, `Reranker decision: ${bestSkillName} (confidence=${decisionConfidence.toFixed(2)})`);
    } catch (err) {
      console.warn(`[Router] LLM re-rank failed, returning no skill: ${(err as Error).message || err}`);
      bestSkillName = 'none';
    }

    if (bestSkillName === 'none') return [];

    // Return top candidates ranked by score, with the LLM's pick first
    const ranked = candidates.slice().sort((a, b) => b.score - a.score);
    const best = ranked.find(
      (c) => c.skill.manifest.name.toLowerCase() === bestSkillName,
    );
    if (!best) return [];

    // Move the LLM's pick to the front, then remaining by score
    const rest = ranked.filter(c => c.skill.manifest.name.toLowerCase() !== bestSkillName);
    const ordered = [best, ...rest];

    return ordered.map(c => ({
      skill: c.skill,
      score: c.score,
      confidence: normalizeConfidence(c.score),
      reason: c === best
        ? `Selected "${c.skill.manifest.name}" as the best match for your request.`
        : `Fallback candidate "${c.skill.manifest.name}" (score: ${c.score.toFixed(3)}).`,
    }));
  }

  private penalizeUnconfiguredSkills(
    candidates: Array<{ skill: LoadedSkill; score: number }>,
  ): Array<{ skill: LoadedSkill; score: number }> {
    return candidates.map(entry => {
      const missingCreds = getRequiredEnvVars(entry.skill.manifest).filter(v => !process.env[v.key]);
      const missingBins = getRequiredBins(entry.skill.manifest).filter(b => !isBinAvailable(b));
      const penalty = (missingCreds.length > 0 ? 0.25 : 0) + (missingBins.length > 0 ? 0.25 : 0);
      if (penalty === 0) return entry;
      return { ...entry, score: Math.max(0, entry.score - penalty) };
    });
  }

  /**
   * Keyword-only fallback when embeddings are unavailable.
   */
  private keywordFallback(eligible: VectorEntry[], routingQuery: string): RoutingResultCandidate[] {
    const tokens = extractQueryTokens(routingQuery);
    const scored = eligible.map(({ skill }) => {
      const keywordHits = scoreKeywordMatch(tokens, skill);
      const routingScore = skill.routingScore ?? (skill.rating / 5);
      const ratingBoost = routingScore * RATING_WEIGHT;
      const negCount = skill.negativeFeedbackCount ?? 0;
      const penalty = negCount * FAILURE_PENALTY;
      const catchAllPenalty = isCatchAllSkill(skill) ? CATCHALL_PENALTY : 0;
      return { skill, score: keywordHits + ratingBoost - penalty - catchAllPenalty };
    });
    scored.sort((a, b) => b.score - a.score);
    const withHits = scored.filter(s => scoreKeywordMatch(tokens, s.skill) > 0);
    return (withHits.length > 0 ? withHits : scored).slice(0, LLM_RERANK_CAP);
  }
}

/**
 * Normalize a raw routing score (cosine × routingScore) to a 0-1 confidence value.
 */
function normalizeConfidence(rawScore: number): number {
  const MIN_SCORE = 0.1;
  const MAX_SCORE = 0.8;
  const normalized = (rawScore - MIN_SCORE) / (MAX_SCORE - MIN_SCORE);
  return Math.max(0, Math.min(1, Math.round(normalized * 100) / 100));
}
