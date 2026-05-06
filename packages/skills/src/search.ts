/** CJK character range (Chinese, Japanese, Korean) */
export const CJK_RANGE = /[　-鿿가-힯豈-﫿]/;

/**
 * Extract meaningful query tokens. For Latin text, splits on word boundaries
 * and filters short words (3+ chars). For CJK text, keeps individual characters.
 */
export function extractQueryTokens(query: string): string[] {
  const lower = query.toLowerCase();
  const tokens: string[] = [];
  const latinWords = lower.match(/[a-z]{3,}/g) ?? [];
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
