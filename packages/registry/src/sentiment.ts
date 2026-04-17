export type Sentiment = 'positive' | 'negative' | 'neutral';

export interface SentimentResult {
  sentiment: Sentiment;
}

const POSITIVE_PATTERN = /\b(great|perfect|thanks|exactly|works|helpful|awesome|correct|spot\s*on|that'?s\s*right|nice|good|love|amazing|excellent)\b/i;

const NEGATIVE_PATTERN = /\b(wrong|incorrect|bad|doesn'?t\s*work|does\s*not\s*work|try\s*again|not\s*what|error|failed|useless|terrible|not\s*helpful|broken|garbage|awful|hate)\b/i;

export function detectSentiment(text: string): SentimentResult {
  if (!text || text.trim().length === 0) {
    return { sentiment: 'neutral' };
  }

  if (NEGATIVE_PATTERN.test(text)) {
    return { sentiment: 'negative' };
  }

  if (POSITIVE_PATTERN.test(text)) {
    return { sentiment: 'positive' };
  }

  return { sentiment: 'neutral' };
}

/**
 * Determine whether a message is likely feedback about a previous response
 * rather than a new query. Uses two-signal check:
 * 1. Contains sentiment keywords (positive or negative)
 * 2. Does NOT look like a new query (no question marks, no command verbs)
 */
export function isLikelyFeedback(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;

  // Must contain sentiment keywords
  const sentiment = detectSentiment(trimmed);
  if (sentiment.sentiment === 'neutral') return false;

  // Must NOT look like a new query
  const querySignals = /\?|^(what|who|where|when|how|why|which|can|could|would|should|is|are|do|does|did|find|look|search|get|show|tell|list|check|compare|translate|convert|calculate)\b/i;
  if (querySignals.test(trimmed)) return false;

  // Sentiment keywords present + no query signals = likely feedback
  return true;
}
