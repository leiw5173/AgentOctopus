import type { LoadedSkill } from '@octopus/registry';
import { type ChatClient, type EmbedClient, type LLMConfig, createChatClient, createEmbedClient, skillToText } from './llm-client.js';

export interface RoutingResult {
  skill: LoadedSkill;
  score: number;
  reason: string;
}

const RATING_WEIGHT = 0.15;

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

export class Router {
  private index: VectorEntry[] = [];
  private chatClient: ChatClient;
  private embedClient: EmbedClient;

  constructor(chatConfig: LLMConfig, embedConfig: LLMConfig) {
    this.chatClient = createChatClient(chatConfig);
    this.embedClient = createEmbedClient(embedConfig);
  }

  async buildIndex(skills: LoadedSkill[]): Promise<void> {
    this.index = [];
    for (const skill of skills) {
      const text = skillToText(skill);
      try {
        const embedding = await this.embedClient.embed(text);
        this.index.push({ skill, embedding });
      } catch (err) {
        console.warn(`[Router] Failed to embed skill "${skill.manifest.name}": ${(err as Error).message || err}`);
      }
    }
  }

  async route(query: string, topK = 3): Promise<RoutingResult[]> {
    if (this.index.length === 0) return [];

    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.embedClient.embed(query);
    } catch (err) {
      console.error(`[Router] Failed to embed query: ${(err as Error).message || err}`);
      return [];
    }

    const scored = this.index.map(({ skill, embedding }) => {
      const cosine = cosineSimilarity(queryEmbedding, embedding);
      const ratingBoost = (skill.rating / 5) * RATING_WEIGHT;
      return { skill, score: cosine + ratingBoost };
    });

    scored.sort((a, b) => b.score - a.score);
    const candidates = scored.slice(0, topK);
    if (candidates.length === 0) return [];

    const candidateList = candidates
      .map((c, i) => `${i + 1}. ${c.skill.manifest.name}: ${c.skill.manifest.description}`)
      .join('\n');

    const systemPrompt = `You are a routing assistant. Given a user request and a list of candidate skills, pick the single best skill to handle it — but ONLY if the skill is clearly relevant to the request. If the request is a general knowledge question, a definition, a "what does X mean" question, or simply not something any of the listed skills can handle, respond with exactly the word "none". Respond with ONLY the skill name (exactly as listed) or "none", nothing else.`;
    const userMessage = `User request: "${query}"\n\nCandidates:\n${candidateList}\n\nBest skill (or "none" if no skill fits):`;

    let bestSkillName: string;
    try {
      bestSkillName = (await this.chatClient.chat(systemPrompt, userMessage)).trim().toLowerCase();
    } catch (err) {
      console.warn(`[Router] LLM re-rank failed, falling back to top similarity match: ${(err as Error).message || err}`);
      bestSkillName = candidates[0].skill.manifest.name;
    }

    // LLM decided no skill fits
    if (bestSkillName === 'none') return [];

    const best = candidates.find(
      (c) => c.skill.manifest.name.toLowerCase() === bestSkillName,
    ) ?? candidates[0];

    return [
      {
        skill: best.skill,
        score: best.score,
        reason: `Selected "${best.skill.manifest.name}" as the best match for your request.`,
      },
    ];
  }
}
