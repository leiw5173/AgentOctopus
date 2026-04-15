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

const RATING_WEIGHT = 0.15;
const IP_ADDRESS_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/;
const DOMAIN_PATTERN = /\b(?=.{1,253}\b)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/i;
const WEATHER_KEYWORDS = /\b(weather|temperature|forecast|rain|snow|wind|humidity|sunny|cloudy|storm|climate)\b/i;
const TRANSLATION_KEYWORDS = /\b(translate|translation|in\s+(french|spanish|japanese|chinese|english|german|italian|portuguese|korean|arabic|russian)|to\s+(french|spanish|japanese|chinese|english|german|italian|portuguese|korean|arabic|russian))\b/i;

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

interface VectorEntry {
  skill: LoadedSkill;
  embedding: number[];
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

  private skillsHash(skills: LoadedSkill[]): string {
    const content = skills.map(s => `${s.manifest.name}:${skillToText(s)}`).join('|');
    return createHash('sha1').update(this.embedModel + ':' + content).digest('hex').slice(0, 16);
  }

  private loadEmbedCache(hash: string): Map<string, number[]> | null {
    try {
      const cachePath = this.embedCachePath();
      if (!fs.existsSync(cachePath)) return null;
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (raw.hash !== hash) return null;
      return new Map(Object.entries(raw.embeddings as Record<string, number[]>));
    } catch {
      return null;
    }
  }

  private saveEmbedCache(hash: string, embeddings: Map<string, number[]>): void {
    try {
      const cachePath = this.embedCachePath();
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify({
        hash,
        embeddings: Object.fromEntries(embeddings),
      }));
    } catch {
      // cache write failure is non-fatal
    }
  }

  async buildIndex(skills: LoadedSkill[]): Promise<void> {
    this.index = [];

    // For large registries, skip embedding entirely — LLM-only routing is
    // fast and accurate enough when the LLM re-ranker sees keyword-filtered candidates.
    const LARGE_REGISTRY_THRESHOLD = 500;
    if (!this.embedClient || skills.length > LARGE_REGISTRY_THRESHOLD) {
      this.index = skills.map(skill => ({ skill, embedding: [] }));
      return;
    }

    const hash = this.skillsHash(skills);
    const cached = this.loadEmbedCache(hash);

    if (cached) {
      // All embeddings available from disk cache — no network calls needed
      this.index = skills.map(skill => ({
        skill,
        embedding: cached.get(skill.manifest.name) ?? [],
      }));
      return;
    }

    // No cache or stale — embed all skills in parallel and save
    const EMBED_CONCURRENCY = 16;
    const embeddings = new Map<string, number[]>();
    const entries: VectorEntry[] = new Array(skills.length);

    let nextIdx = 0;
    let embeddedCount = 0;

    const worker = async () => {
      while (nextIdx < skills.length) {
        const idx = nextIdx++;
        const skill = skills[idx]!;
        const text = skillToText(skill);
        try {
          const embedding = await this.embedClient!.embed(text);
          entries[idx] = { skill, embedding };
          embeddings.set(skill.manifest.name, embedding);
          embeddedCount++;
        } catch {
          entries[idx] = { skill, embedding: [] };
        }
      }
    };

    await Promise.all(Array.from({ length: EMBED_CONCURRENCY }, worker));
    this.index = entries;

    if (embeddedCount > 0) {
      this.saveEmbedCache(hash, embeddings);
    }
  }

  async route(query: string, topK = 3): Promise<RoutingResult[]> {
    if (this.index.length === 0) return [];

    const eligible = this.index.filter(({ skill }) => isSkillEligible(skill, query));
    if (eligible.length === 0) return [];

    let candidates: RoutingResultCandidate[];

    const isLLMOnly = !this.embedClient || eligible.every(e => e.embedding.length === 0);

    if (isLLMOnly) {
      // No embed client or all embeddings empty — pre-filter by keyword relevance
      // so the LLM re-ranker never receives more than LLM_RERANK_CAP candidates.
      const LLM_RERANK_CAP = 20;
      if (eligible.length <= LLM_RERANK_CAP) {
        candidates = eligible.map(({ skill }) => ({ skill, score: 1.0 }));
      } else {
        // Score by how many query words appear in name+description+tags
        const words = query.toLowerCase().split(/\W+/).filter(w => w.length > 2);
        const scored = eligible.map(({ skill }) => {
          const haystack = (
            skill.manifest.name + ' ' +
            skill.manifest.description + ' ' +
            skill.manifest.tags.join(' ')
          ).toLowerCase();
          const hits = words.filter(w => haystack.includes(w)).length;
          return { skill, score: hits };
        });
        scored.sort((a, b) => b.score - a.score);
        candidates = scored.slice(0, LLM_RERANK_CAP);
      }
    } else {
      let queryEmbedding: number[] = [];
      try {
        queryEmbedding = await this.embedClient!.embed(query);
      } catch (err) {
        console.warn(`[Router] Failed to embed query, falling back to LLM-only: ${(err as Error).message || err}`);
      }

      if (queryEmbedding.length > 0) {
        const scored = eligible.map(({ skill, embedding }) => {
          const cosine = cosineSimilarity(queryEmbedding, embedding);
          const ratingBoost = (skill.rating / 5) * RATING_WEIGHT;
          return { skill, score: cosine + ratingBoost };
        });
        scored.sort((a, b) => b.score - a.score);
        candidates = scored.slice(0, topK);
      } else {
        candidates = eligible.map(({ skill }) => ({ skill, score: 1.0 }));
      }
    }

    if (candidates.length === 0) return [];

    const candidateList = candidates
      .map((c, i) => `${i + 1}. ${c.skill.manifest.name}: ${c.skill.manifest.description}`)
      .join('\n');

    const systemPrompt = `You are a routing assistant. Given a user request and a list of candidate skills, pick the single best skill to handle it — but ONLY if the skill is clearly relevant to the request. If the request is a general knowledge question, a definition, a "what does X mean" question, or simply not something any of the listed skills can handle, respond with exactly the word "none". Respond with ONLY the skill name (exactly as listed) or "none", nothing else.`;
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
