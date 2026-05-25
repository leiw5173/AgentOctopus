/** CJK character range (Chinese, Japanese, Korean) */
export const CJK_RANGE = /[　-鿿가-힯豈-﫿]/;

/** English stop words that should not be used as query tokens */
const STOP_WORDS = new Set([
  'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'how',
  'the', 'this', 'that', 'these', 'those',
  'and', 'but', 'nor', 'for', 'yet', 'with',
  'are', 'was', 'were', 'been', 'being',
  'have', 'has', 'had', 'does', 'did',
  'will', 'would', 'shall', 'should', 'may', 'might', 'must', 'can', 'could',
  'not', 'than', 'then', 'also', 'just', 'only', 'very',
  'from', 'into', 'onto', 'upon', 'within',
  'its', 'hers', 'his', 'mine', 'ours', 'yours', 'theirs',
]);

/**
 * Extract meaningful query tokens. For Latin text, splits on word boundaries,
 * filters stop words, and keeps words with 3+ chars. For CJK text, keeps
 * individual characters.
 */
export function extractQueryTokens(query: string): string[] {
  const lower = query.toLowerCase();
  const tokens: string[] = [];
  const latinWords = (lower.match(/[a-z]{3,}/g) ?? [])
    .filter(w => !STOP_WORDS.has(w));
  tokens.push(...latinWords);
  const cjkChars = lower.match(/[　-鿿가-힯豈-﫿]/g) ?? [];
  tokens.push(...cjkChars);
  return [...new Set(tokens)];
}

/** Minimal interface for scoring — avoids circular dependency on @agentoctopus/registry */
export interface SearchableSkill {
  name: string;
  description: string;
  tags: string[];
}

/**
 * Score how well a skill matches query tokens. Uses word-boundary-start
 * prefix matching for Latin words — token must start at a word boundary but
 * can be a prefix of a longer word. For CJK characters, checks direct inclusion.
 *
 * Scoring: +2 for name match, +1 for description/tag match per token.
 */
export function scoreKeywordMatch(tokens: string[], skill: SearchableSkill): number {
  const name = skill.name.toLowerCase();
  const desc = skill.description.toLowerCase();
  const tags = (Array.isArray(skill.tags) ? skill.tags.join(' ') : '').toLowerCase();

  let score = 0;
  for (const token of tokens) {
    if (CJK_RANGE.test(token)) {
      if (name === token) score += 4;
      else if (name.includes(token)) score += 2;
      else if (desc.includes(token)) score += 1;
      else if (tags.includes(token)) score += 1;
    } else {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const prefixPattern = new RegExp(`^${escaped}\\b`, 'i');
      const pattern = new RegExp(`\\b${escaped}`, 'i');
      if (name === token) score += 4;
      else if (prefixPattern.test(name)) score += 3;
      else if (pattern.test(name)) score += 2;
      else if (pattern.test(desc)) score += 1;
      else if (pattern.test(tags)) score += 1;
    }
  }
  return score;
}
