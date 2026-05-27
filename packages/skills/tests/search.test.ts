import { describe, it, expect } from 'vitest';
import { extractQueryTokens, scoreKeywordMatch, type SearchableSkill } from '../src/search.js';

describe('extractQueryTokens', () => {
  it('extracts Latin words of 3+ characters', () => {
    const tokens = extractQueryTokens('weather forecast today');
    expect(tokens).toEqual(['weather', 'forecast', 'today']);
  });

  it('filters out short words (1-2 chars)', () => {
    const tokens = extractQueryTokens('is it sunny in to');
    expect(tokens).toEqual(['sunny']);
  });

  it('extracts CJK characters', () => {
    const tokens = extractQueryTokens('天気 予報');
    expect(tokens).toEqual(expect.arrayContaining(['天', '気', '予', '報']));
    expect(tokens).toHaveLength(4);
  });

  it('deduplicates tokens', () => {
    const tokens = extractQueryTokens('weather weather WEATHER');
    expect(tokens).toEqual(['weather']);
  });

  it('handles mixed Latin and CJK', () => {
    const tokens = extractQueryTokens('東京 weather');
    expect(tokens).toContain('weather');
    expect(tokens).toContain('東');
    expect(tokens).toContain('京');
  });
});

describe('scoreKeywordMatch', () => {
  const skill: SearchableSkill = {
    name: 'weather-forecast',
    description: 'Get weather forecasts and current conditions',
    tags: ['weather', 'api', 'forecast'],
  };

  it('scores name prefix match highest', () => {
    const tokens = extractQueryTokens('weather');
    const score = scoreKeywordMatch(tokens, skill);
    expect(score).toBe(3); // name prefix match ("weather" prefix of "weather-forecast")
  });

  it('scores partial name word-boundary match', () => {
    const tokens = extractQueryTokens('forecast');
    const score = scoreKeywordMatch(tokens, skill);
    expect(score).toBe(2); // "forecast" matches word boundary in "weather-forecast"
  });

  it('scores description match lower', () => {
    const tokens = extractQueryTokens('conditions');
    const score = scoreKeywordMatch(tokens, skill);
    expect(score).toBe(1); // in description only
  });

  it('scores tag match lower', () => {
    const tokens = extractQueryTokens('api');
    const score = scoreKeywordMatch(tokens, skill);
    expect(score).toBe(1); // in tags only
  });

  it('scores multiple tokens cumulatively', () => {
    const tokens = extractQueryTokens('weather conditions');
    const score = scoreKeywordMatch(tokens, skill);
    expect(score).toBe(4); // name prefix (3) + description (1)
  });

  it('scores exact skill name higher than compound name match', () => {
    const tokens = extractQueryTokens('weather');
    const exactSkill: SearchableSkill = {
      name: 'weather',
      description: 'Get weather forecasts and current conditions',
      tags: ['weather'],
    };
    const compoundSkill: SearchableSkill = {
      name: 'soaring-weather',
      description: 'Soaring forecast with thermal weather conditions',
      tags: ['weather'],
    };

    expect(scoreKeywordMatch(tokens, exactSkill)).toBeGreaterThan(scoreKeywordMatch(tokens, compoundSkill));
  });

  it('returns 0 for no match', () => {
    const tokens = extractQueryTokens('xyzzy nothing');
    const score = scoreKeywordMatch(tokens, skill);
    expect(score).toBe(0);
  });

  it('handles CJK token matching', () => {
    const cjkSkill: SearchableSkill = {
      name: '天気予報',
      description: '天気予報を取得します',
      tags: ['天気'],
    };
    const tokens = extractQueryTokens('天気');
    const score = scoreKeywordMatch(tokens, cjkSkill);
    // extractQueryTokens splits CJK into individual characters: ['天', '気']
    // Both 天 and 気 match the name '天気予報', scoring +2 each = 4
    expect(score).toBe(4);
  });
});
