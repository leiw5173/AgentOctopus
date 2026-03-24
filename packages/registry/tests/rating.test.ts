import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RatingStore } from '../src/rating.js';
import fs from 'fs';

vi.mock('fs');

describe('RatingStore', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('initializes with default rating for a new skill', () => {
    const store = new RatingStore('/mock/path.json');
    const entry = store.getOrCreate('test-skill');
    expect(entry.rating).toBe(3.0);
    expect(entry.invocations).toBe(0);
  });

  it('records positive feedback and increases rating', () => {
    const store = new RatingStore('/mock/path.json');
    store.getOrCreate('test-skill', 3.0);
    store.recordFeedback('test-skill', true, 'Great!');
    const rating = store.getRating('test-skill');
    expect(rating).toBe(3.1); // 3.0 + 0.1 weight
  });

  it('records negative feedback and decreases rating', () => {
    const store = new RatingStore('/mock/path.json');
    store.getOrCreate('test-skill', 3.0);
    store.recordFeedback('test-skill', false, 'Bad!');
    const rating = store.getRating('test-skill');
    expect(rating).toBe(2.9); // 3.0 - 0.1 weight
  });

  it('caps rating at 5.0 and 0.0', () => {
    const store = new RatingStore('/mock/path.json');
    store.getOrCreate('max-skill', 5.0);
    store.recordFeedback('max-skill', true);
    expect(store.getRating('max-skill')).toBe(5.0);

    store.getOrCreate('min-skill', 0.0);
    store.recordFeedback('min-skill', false);
    expect(store.getRating('min-skill')).toBe(0.0);
  });
});
