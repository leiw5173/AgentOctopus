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
