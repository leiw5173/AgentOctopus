import type { LoadedSkill } from '@agentoctopus/registry';
import { getRequiredEnvVars, getRequiredBins, getSkillEntry } from '@agentoctopus/registry';
import { shouldIncludeSkill, extractQueryTokens, scoreKeywordMatch, CJK_RANGE, type SkillEligibilityContext } from '@agentoctopus/skills';
import type { SkillsConfig } from '@agentoctopus/skills';
import { type ChatClient, type EmbedClient, type LLMConfig, createChatClient, createEmbedClient, skillToText } from './llm-client.js';
import type { ExecutionContext, TelemetrySink, RoutingCompletedEvent } from './execution-context.js';
import { isBinAvailable } from './utils.js';
import { getConfig } from './config-resolver.js';
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

/**
 * Detect if a query contains non-Latin characters (CJK, Cyrillic, Arabic, etc.)
 */
function hasNonLatinChars(query: string): boolean {
  return /[^\x00-\x7F]/.test(query.replace(/\s/g, ''));
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

/** Mutable per-route() telemetry state threaded through routeInner so the
 *  public route() can emit exactly one routing.completed event regardless of
 *  which return path produced the result. */
interface RouteTelemetryState {
  intent: string;
  intentUsed: boolean;
  selectionMethod: 'reranker' | 'score-fallback';
  candidates: RoutingResultCandidate[];
}

export class Router {
  private index: VectorEntry[] = [];
  private chatClient: ChatClient;
  private embedClient: EmbedClient | null;
  private embedModel: string;
  private readonly telemetrySink?: TelemetrySink;

  constructor(chatConfig: LLMConfig, embedConfig?: LLMConfig, telemetrySink?: TelemetrySink) {
    this.chatClient = createChatClient(chatConfig);
    this.embedClient = embedConfig ? createEmbedClient(embedConfig) : null;
    this.embedModel = embedConfig?.model ?? '';
    this.telemetrySink = telemetrySink;
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
  async route(query: string, topK = 20, opts: { debug?: boolean; previousSkill?: string; execContext?: ExecutionContext } = {}): Promise<RoutingResult[]> {
    const { execContext } = opts;
    const state: RouteTelemetryState = {
      intent: query,
      intentUsed: false,
      selectionMethod: 'reranker',
      candidates: [],
    };
    const results = await this.routeInner(query, topK, opts, state);

    // Emit exactly one routing.completed per route() call, regardless of which
    // return path produced the result. A throwing sink must never break routing.
    if (this.telemetrySink) {
      try {
        const winner = results.length > 0 ? results[0] : undefined;
        const sortedCandidates = state.candidates.slice().sort((a, b) => b.score - a.score);
        const selectedCandidateRank = winner
          ? sortedCandidates.findIndex(c => c.skill === winner.skill)
          : null;
        const event: RoutingCompletedEvent = {
          kind: 'routing.completed',
          traceId: execContext?.traceId,
          intent: state.intent,
          intentSource: state.intentUsed ? 'llm' : 'original-query-fallback',
          intentExtractionSucceeded: state.intentUsed,
          candidatesConsidered: state.candidates.length,
          selected: winner ? winner.skill.manifest.name : null,
          selectedRawScore: winner ? winner.score : null,
          normalizedConfidence: winner ? winner.confidence : null,
          candidates: state.candidates.map(c => ({ name: c.skill.manifest.name, rawScore: c.score })),
          selectionMethod: state.selectionMethod,
          selectedCandidateRank: selectedCandidateRank === -1 ? null : selectedCandidateRank,
        };
        this.telemetrySink.emit(event);
      } catch {
        // Telemetry sink failure is non-fatal — routing must not be affected.
      }
    }

    return results;
  }

  private async routeInner(query: string, topK: number, opts: { debug?: boolean; previousSkill?: string; execContext?: ExecutionContext }, state: RouteTelemetryState): Promise<RoutingResult[]> {
    const { debug = false, previousSkill } = opts;
    if (this.index.length === 0) return [];

    // For non-Latin queries: merge translation + intent extraction into a single LLM call.
    // For Latin queries: only extract intent (translation not needed).
    let routingQuery = query;
    let embedQuery = query;
    const isNonLatin = hasNonLatinChars(query);

    if (isNonLatin) {
      // Combined prompt: translate AND extract intent in one round-trip
      try {
        const combined = await this.chatClient.chat(
          'Given this user request, output JSON with exactly two fields:\n' +
          '  "translation": English translation of the request (preserve URLs and technical terms as-is)\n' +
          '  "intent": a short English phrase describing what the user wants to do (e.g. "get AI news", "shorten a URL")\n' +
          'Output ONLY the JSON object, no other text.',
          query,
        );
        try {
          const parsed = JSON.parse(combined.trim()) as { translation?: string; intent?: string };
          if (parsed.translation) routingQuery = `${query} ${parsed.translation}`;
          if (parsed.intent && parsed.intent.length < routingQuery.length) {
            embedQuery = parsed.intent;
            state.intentUsed = true;
          } else {
            embedQuery = routingQuery;
          }
        } catch {
          // JSON parse failed — fall back to full query
          embedQuery = routingQuery;
        }
      } catch {
        // LLM call failed — proceed with original query
        embedQuery = routingQuery;
      }
    } else {
      // Latin query: extract intent only (no translation needed)
      try {
        const intent = await this.chatClient.chat(
          'Extract the user\'s core intent from this request. Output ONLY a short phrase describing what they want to do (e.g. "shorten a URL", "get weather forecast", "translate text to French"). Remove URLs, code snippets, and domain names. Do not explain, just output the intent.',
          query,
        );
        const trimmed = intent.trim();
        if (trimmed && trimmed.length < query.length) {
          embedQuery = trimmed;
          state.intentUsed = true;
        }
      } catch {
        // Intent extraction failed — use full query for embedding
      }
    }

    // Build eligibility context once for all skills
    state.intent = embedQuery;
    const skillsConfig = getConfig().skills;
    const eligibility: SkillEligibilityContext = {
      hasBin: (bin: string) => isBinAvailable(bin),
      hasAnyBin: (bins: string[]) => bins.some(b => isBinAvailable(b)),
      hasEnv: (key: string) => !!process.env[key],
      isConfigPathTruthy: (_path: string) => true, // config path check not applicable at routing time
      os: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
    };

    const eligible: VectorEntry[] = [];
    for (const entry of this.index) {
      const pass = shouldIncludeSkill({
        entry: getSkillEntry(entry.skill),
        config: skillsConfig as unknown as SkillsConfig,
        eligibility,
      });
      if (!pass) {
        dbg(debug, `shouldIncludeSkill: ${entry.skill.manifest.name} → SKIP`);
        continue;
      }

      // Filter out agent-only skills that cannot execute in CLI context.
      // Agent-only skills have `allowed-tools` in their frontmatter but no
      // endpoint, no scripts/, and no invoke.js — they are designed for
      // agent-level tool calling (MCP/OpenClaw), not standalone execution.
      const fm = getSkillEntry(entry.skill).frontmatter;
      if (fm?.['allowed-tools'] && !entry.skill.manifest.endpoint) {
        const scriptsDir = entry.skill.dirPath ? path.join(entry.skill.dirPath, 'scripts') : '';
        const hasScripts = scriptsDir && fs.existsSync(scriptsDir) && fs.readdirSync(scriptsDir).length > 0;
        if (!hasScripts) {
          dbg(debug, `shouldIncludeSkill: ${entry.skill.manifest.name} → SKIP (agent-only, no executable scripts or endpoint)`);
          continue;
        }
      }

      dbg(debug, `shouldIncludeSkill: ${entry.skill.manifest.name} → PASS`);
      eligible.push(entry);
    }
    if (eligible.length === 0) return [];

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
            const routingScore = Math.max(RELIABILITY_FLOOR, skill.routingScore || (skill.rating / 5));
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

    // When a previous skill is provided (session follow-up), ensure it appears
    // in the candidate list so the reranker can choose to reuse it.
    if (previousSkill) {
      const alreadyIn = candidates.some(c => c.skill.manifest.name.toLowerCase() === previousSkill.toLowerCase());
      dbg(debug, `previousSkill=${previousSkill}, alreadyInCandidates=${alreadyIn}`);
      if (!alreadyIn) {
        const prevEntry = this.index.find(e => e.skill.manifest.name.toLowerCase() === previousSkill.toLowerCase());
        if (prevEntry) {
          const medianScore = candidates.length > 0
            ? candidates.map(c => c.score).sort((a, b) => a - b)[Math.floor(candidates.length / 2)]
            : 0.5;
          candidates.push({ skill: prevEntry.skill, score: medianScore });
          dbg(debug, `Boosted previousSkill "${previousSkill}" into candidates with score=${medianScore.toFixed(3)}`);
        } else {
          dbg(debug, `previousSkill "${previousSkill}" not found in index — cannot boost`);
        }
      }
    }

    // Snapshot the candidate list fed to the reranker for telemetry. This is
    // the list after cosine topK + keyword-boost + penalize + previousSkill
    // injection — the exact set the reranker prompt is built from.
    state.candidates = candidates;

    // LLM rerank
    const candidateList = candidates
      .map((c, i) => {
        const neg = c.skill.negativeFeedbackCount ?? 0;
        const flags: string[] = [];
        if (neg > 0) flags.push(`⚠ ${neg} negative`);
        const missingBins = getRequiredBins(c.skill.manifest).filter(b => !isBinAvailable(b));
        const missingCreds = getRequiredEnvVars(c.skill.manifest).filter(v => !process.env[v.key]);
        if (missingBins.length > 0) flags.push(`❌ missing tools: ${missingBins.join(', ')}`);
        if (missingCreds.length > 0) flags.push(`🔑 needs API keys`);
        const flagNote = flags.length > 0 ? ` [${flags.join(' | ')}]` : '';
        let desc = c.skill.manifest.description;
        if (desc.length > 120) desc = desc.slice(0, 120) + '…';
        return `${i + 1}. ${c.skill.manifest.name} (score: ${c.score.toFixed(2)})${flagNote}: ${desc}`;
      })
      .join('\n');

    const systemPrompt = `You are a routing assistant. Given a user request and a list of candidate skills, pick the single best skill that SPECIFICALLY handles the user's request. Follow these rules:

1. Match the skill's PRIMARY purpose to the user's intent — ignore skills that only tangentially relate.
2. Skills marked with ❌ are MISSING required tools and CANNOT RUN — avoid them unless no alternative exists.
3. Skills marked with ⚠ have received negative user feedback — strongly prefer alternatives.
4. Skills with very broad descriptions ("any request", "any task", "any query") are LESS likely to be correct — prefer specific, purpose-built skills.
5. When multiple skills relate to the same topic (e.g. YouTube), pick the one whose description most precisely matches the user's action (e.g. "extract transcript/subtitles" → transcript skill, NOT notification/analysis).
6. For translation requests, prefer skills that describe themselves as translation/language-translation tools — NOT language tutors, dictionaries, or greeting skills.
7. Prefer skills with higher scores — they have better performance and reliability.
8. Respond "none" if no skill is a genuine match for what the user is asking.

Respond with ONLY the skill name (exactly as listed) or "none", nothing else.`;
    const prevCtx = previousSkill ? `\nPrevious skill used in this conversation: ${previousSkill}. If the user's request is a follow-up (e.g. "what about X?", "and Paris?"), strongly prefer reusing this skill or a closely related one.` : '';
    const userMessage = `User request: "${query}"${prevCtx}\n\nCandidates:\n${candidateList}\n\nBest skill (or "none" if no skill fits):`;

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
      const msg = (err as Error).message || String(err);
      console.warn(`[Router] LLM re-rank failed, falling back to embedding scores: ${msg.slice(0, 100)}`);
      // LLM is unavailable — fall back to top embedding/cosine match
      const ranked = candidates.slice().sort((a, b) => b.score - a.score);
      if (ranked.length === 0) return [];
      const top = ranked[0];
      dbg(debug, `Reranker fallback: ${top.skill.manifest.name} (score=${top.score.toFixed(3)})`);
      state.selectionMethod = 'score-fallback';
      state.candidates = ranked;
      return [{ skill: top.skill, score: top.score, confidence: normalizeConfidence(top.score), reason: 'embedding fallback (LLM unavailable)' }];
    }

    if (bestSkillName === 'none') return [];

    // The reranker picks the best skill based on semantic understanding of
    // descriptions; embedding scores handle initial filtering. When the reranker
    // selects a specific skill, prefer it over the raw embedding ranking — but
    // keep remaining candidates sorted by score for fallback ordering.
    const ranked = candidates.slice().sort((a, b) => b.score - a.score);
    const rerankerPick = candidates.find(c => c.skill.manifest.name.toLowerCase() === bestSkillName);
    const best = rerankerPick ?? ranked[0];
    if (!best) return [];

    // Return best first, then remaining candidates by embedding score
    const rest = ranked.filter(c => c !== best);
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
      const penalty = (missingCreds.length > 0 ? 0.25 : 0) + (missingBins.length > 0 ? 1.5 : 0);
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
      const keywordHits = scoreKeywordMatch(tokens, {
        name: skill.manifest.name,
        description: skill.manifest.description,
        tags: skill.manifest.tags,
      });
      const routingScore = skill.routingScore || (skill.rating / 5);
      const ratingBoost = routingScore * RATING_WEIGHT;
      const negCount = skill.negativeFeedbackCount ?? 0;
      const penalty = negCount * FAILURE_PENALTY;
      const catchAllPenalty = isCatchAllSkill(skill) ? CATCHALL_PENALTY : 0;
      return { skill, score: keywordHits + ratingBoost - penalty - catchAllPenalty };
    });
    scored.sort((a, b) => b.score - a.score);
    const withHits = scored.filter(s => scoreKeywordMatch(tokens, {
      name: s.skill.manifest.name,
      description: s.skill.manifest.description,
      tags: s.skill.manifest.tags,
    }) > 0);
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
