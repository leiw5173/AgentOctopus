import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RatingStore } from '../src/rating.js';
import { computeRoutingScore, defaultDimensions } from '../src/rating-dimensions.js';
import fs from 'fs';

vi.mock('fs');

describe('RatingStore', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // --- Legacy tests (kept for backward compatibility) ---

  it('initializes with default rating for a new skill', () => {
    const store = new RatingStore('/mock/path.json');
    const entry = store.getOrCreate('test-skill');
    expect(entry.dimensions.quality).toBe(3.0);
    expect(entry.invocations).toBe(0);
  });

  it('records positive feedback and increases quality', () => {
    const store = new RatingStore('/mock/path.json');
    store.getOrCreate('test-skill', 3.0);
    store.recordFeedback('test-skill', true, 'Great!');
    const rating = store.getRating('test-skill');
    expect(rating).toBe(3.1); // 3.0 + 0.1 weight
  });

  it('records negative feedback and decreases quality', () => {
    const store = new RatingStore('/mock/path.json');
    store.getOrCreate('test-skill', 3.0);
    store.recordFeedback('test-skill', false, 'Bad!');
    const rating = store.getRating('test-skill');
    expect(rating).toBe(2.9); // 3.0 - 0.1 weight
  });

  it('caps quality at 5.0 and 0.0', () => {
    const store = new RatingStore('/mock/path.json');
    store.getOrCreate('max-skill', 5.0);
    store.recordFeedback('max-skill', true);
    expect(store.getRating('max-skill')).toBe(5.0);

    store.getOrCreate('min-skill', 0.0);
    store.recordFeedback('min-skill', false);
    expect(store.getRating('min-skill')).toBe(0.0);
  });

  // --- New tests ---

  it('getOrCreate returns default dimensions', () => {
    const store = new RatingStore('/mock/path.json');
    const entry = store.getOrCreate('new-skill', 3.5);
    expect(entry.dimensions.quality).toBe(3.5);
    expect(entry.dimensions.completion).toBe(1.0);
    expect(entry.dimensions.reliability).toBe(1.0);
    expect(entry.dimensions.latency).toBe(0.5);
    expect(entry.dimensions.tokenCost).toBe(0.5);
    expect(entry.invocations).toBe(0);
    expect(entry.lastInvoked).toBe('');
    expect(entry.recentFeedback).toEqual([]);
    expect(entry.metrics.totalSuccess).toBe(0);
    expect(entry.metrics.totalErrors).toBe(0);
    expect(entry.metrics.avgLatencyMs).toBe(0);
    expect(entry.metrics.p95LatencyMs).toBe(0);
    expect(entry.metrics.avgTokenCost).toBe(0);
  });

  it('recordInvocationMetrics updates metrics and recalculates dimensions', () => {
    const store = new RatingStore('/mock/path.json');
    store.recordInvocationMetrics('metric-skill', {
      success: true,
      latencyMs: 500,
      tokenUsage: 100,
    });

    const entry = store.getOrCreate('metric-skill');
    expect(entry.invocations).toBe(1);
    expect(entry.metrics.totalSuccess).toBe(1);
    expect(entry.metrics.totalErrors).toBe(0);
    expect(entry.metrics.avgLatencyMs).toBe(500);
    expect(entry.metrics.avgTokenCost).toBe(100);
    expect(entry.lastInvoked).not.toBe('');

    // Reliability should remain 1.0 with 100% success
    expect(entry.dimensions.reliability).toBe(1.0);
    // Latency: 1 - 500/2000 = 0.75
    expect(entry.dimensions.latency).toBeCloseTo(0.75);
    // Token cost: 1 - 100/500 = 0.8
    expect(entry.dimensions.tokenCost).toBeCloseTo(0.8);
  });

  it('recordInvocationMetrics tracks errors and updates reliability', () => {
    const store = new RatingStore('/mock/path.json');
    store.recordInvocationMetrics('error-skill', { success: true, latencyMs: 100, tokenUsage: 50 });
    store.recordInvocationMetrics('error-skill', { success: false, latencyMs: 200, tokenUsage: 80 });

    const entry = store.getOrCreate('error-skill');
    expect(entry.metrics.totalSuccess).toBe(1);
    expect(entry.metrics.totalErrors).toBe(1);
    // Reliability: 1/2 = 0.5
    expect(entry.dimensions.reliability).toBeCloseTo(0.5);
  });

  it('recordFeedback with source updates quality via EMA and stores source', () => {
    const store = new RatingStore('/mock/path.json');
    store.getOrCreate('source-skill', 3.0);
    store.recordFeedback('source-skill', true, 'Nice work', 'cli', 'one-shot');

    const entry = store.getOrCreate('source-skill');
    expect(entry.dimensions.quality).toBe(3.1);
    expect(entry.recentFeedback[0].source).toBe('cli');
    expect(entry.recentFeedback[0].taskType).toBe('one-shot');
    expect(entry.recentFeedback[0].comment).toBe('Nice work');
    expect(entry.recentFeedback[0].id).toBeTruthy();
  });

  it('recordFeedback caps at 50 entries', () => {
    const store = new RatingStore('/mock/path.json');
    store.getOrCreate('verbose-skill', 3.0);
    for (let i = 0; i < 60; i++) {
      store.recordFeedback('verbose-skill', true, `Feedback ${i}`, 'web');
    }
    const entry = store.getOrCreate('verbose-skill');
    expect(entry.recentFeedback.length).toBe(50);
  });

  it('getRoutingScore returns a valid score', () => {
    const store = new RatingStore('/mock/path.json');
    store.getOrCreate('score-skill', 3.0);
    const score = store.getRoutingScore('score-skill', 'one-shot');
    // Should be between 0 and 1
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);

    // With default dimensions (quality=3.0), we can verify the exact score
    const dims = defaultDimensions();
    dims.quality = 3.0;
    const expected = computeRoutingScore(dims, 'one-shot');
    expect(score).toBeCloseTo(expected);
  });

  it('getRoutingScore returns 0 for unknown skill', () => {
    const store = new RatingStore('/mock/path.json');
    const score = store.getRoutingScore('nonexistent-skill');
    expect(score).toBe(0);
  });

  it('recordInvocation delegates to recordInvocationMetrics', () => {
    const store = new RatingStore('/mock/path.json');
    store.recordInvocation('legacy-skill');
    const entry = store.getOrCreate('legacy-skill');
    expect(entry.invocations).toBe(1);
    expect(entry.metrics.totalSuccess).toBe(1);
  });

  it('migrates old format entries', () => {
    const oldData = {
      'old-skill': {
        skillName: 'old-skill',
        rating: 4.2,
        invocations: 15,
        recentFeedback: [
          { timestamp: '2025-01-01T00:00:00.000Z', positive: true, comment: 'Good' },
          { timestamp: '2025-01-02T00:00:00.000Z', positive: false },
        ],
      },
    };

    // Mock fs to return old format data
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(oldData));

    const store = new RatingStore('/mock/path.json');
    const entry = store.getOrCreate('old-skill');

    // Quality should be migrated from old rating
    expect(entry.dimensions.quality).toBe(4.2);
    // Other dimensions should be defaults
    expect(entry.dimensions.completion).toBe(1.0);
    expect(entry.dimensions.reliability).toBe(1.0);
    expect(entry.dimensions.latency).toBe(0.5);
    expect(entry.dimensions.tokenCost).toBe(0.5);
    // Invocations preserved
    expect(entry.invocations).toBe(15);
    // Feedback entries should have source: 'other' and an id
    expect(entry.recentFeedback.length).toBe(2);
    expect(entry.recentFeedback[0].source).toBe('other');
    expect(entry.recentFeedback[0].id).toBeTruthy();
    // Metrics should be defaults
    expect(entry.metrics.totalSuccess).toBe(0);
    expect(entry.metrics.totalErrors).toBe(0);
  });

  it('does not migrate entries that are already in new format', () => {
    const newData = {
      'new-skill': {
        skillName: 'new-skill',
        dimensions: defaultDimensions(),
        invocations: 5,
        lastInvoked: '2025-06-01T00:00:00.000Z',
        recentFeedback: [],
        metrics: {
          totalSuccess: 5,
          totalErrors: 0,
          avgLatencyMs: 200,
          p95LatencyMs: 400,
          avgTokenCost: 50,
        },
      },
    };

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(newData));

    const store = new RatingStore('/mock/path.json');
    const entry = store.getOrCreate('new-skill');
    expect(entry.dimensions.quality).toBe(3.0);
    expect(entry.metrics.totalSuccess).toBe(5);
    expect(entry.lastInvoked).toBe('2025-06-01T00:00:00.000Z');
  });
});
