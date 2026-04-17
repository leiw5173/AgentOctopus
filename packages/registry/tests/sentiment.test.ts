import { describe, it, expect } from 'vitest';
import { detectSentiment } from '../src/sentiment.js';

describe('sentiment detection', () => {
  it('detects positive keywords', () => {
    expect(detectSentiment("That's perfect, thanks!")).toEqual({ sentiment: 'positive' });
    expect(detectSentiment('Great result!')).toEqual({ sentiment: 'positive' });
    expect(detectSentiment('Exactly what I needed')).toEqual({ sentiment: 'positive' });
    expect(detectSentiment('Works perfectly')).toEqual({ sentiment: 'positive' });
    expect(detectSentiment('Spot on!')).toEqual({ sentiment: 'positive' });
  });

  it('detects negative keywords', () => {
    expect(detectSentiment("That's wrong")).toEqual({ sentiment: 'negative' });
    expect(detectSentiment('Incorrect result')).toEqual({ sentiment: 'negative' });
    expect(detectSentiment("Doesn't work, try again")).toEqual({ sentiment: 'negative' });
    expect(detectSentiment('Not what I asked for')).toEqual({ sentiment: 'negative' });
    expect(detectSentiment('Error in the output')).toEqual({ sentiment: 'negative' });
    expect(detectSentiment('Not helpful at all')).toEqual({ sentiment: 'negative' });
  });

  it('returns neutral for ambiguous text', () => {
    expect(detectSentiment('Tell me more about that')).toEqual({ sentiment: 'neutral' });
    expect(detectSentiment('What about Paris?')).toEqual({ sentiment: 'neutral' });
    expect(detectSentiment('')).toEqual({ sentiment: 'neutral' });
  });

  it('is case-insensitive', () => {
    expect(detectSentiment('PERFECT!')).toEqual({ sentiment: 'positive' });
    expect(detectSentiment('WRONG!')).toEqual({ sentiment: 'negative' });
  });
});
