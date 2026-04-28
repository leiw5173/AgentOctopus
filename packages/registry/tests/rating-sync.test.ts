import { describe, it, expect } from 'vitest';
import { mergeRatings, mergeFeedback } from '../src/rating-sync.js';
import type { RatingEntry, FeedbackEntry } from '../src/rating.js';

describe('rating-sync', () => {
  describe('mergeRatings', () => {
    it('uses cloud data when local has no entry', () => {
      const cloud: RatingEntry = {
        skillName: 'weather',
        dimensions: { completion: 0.9, quality: 4.0, reliability: 0.95, latency: 0.8, tokenCost: 0.7 },
        invocations: 20,
        lastInvoked: '2026-04-17T00:00:00Z',
        recentFeedback: [],
        metrics: { totalSuccess: 18, totalErrors: 2, avgLatencyMs: 400, p95LatencyMs: 600, avgTokenCost: 100 },
      };
      const result = mergeRatings(undefined, cloud);
      expect(result.dimensions.quality).toBeCloseTo(4.0);
      expect(result.invocations).toBe(20);
    });

    it('merges objective dimensions by summing counters', () => {
      const local: RatingEntry = {
        skillName: 'weather',
        dimensions: { completion: 0.8, quality: 3.0, reliability: 0.9, latency: 0.7, tokenCost: 0.8 },
        invocations: 10,
        lastInvoked: '2026-04-16T00:00:00Z',
        recentFeedback: [],
        metrics: { totalSuccess: 8, totalErrors: 2, avgLatencyMs: 500, p95LatencyMs: 750, avgTokenCost: 150 },
      };
      const cloud: RatingEntry = {
        skillName: 'weather',
        dimensions: { completion: 0.9, quality: 4.0, reliability: 0.95, latency: 0.8, tokenCost: 0.7 },
        invocations: 20,
        lastInvoked: '2026-04-17T00:00:00Z',
        recentFeedback: [],
        metrics: { totalSuccess: 18, totalErrors: 2, avgLatencyMs: 400, p95LatencyMs: 600, avgTokenCost: 100 },
      };
      const result = mergeRatings(local, cloud);
      expect(result.metrics.totalSuccess).toBe(26);
      expect(result.metrics.totalErrors).toBe(4);
      expect(result.invocations).toBe(30);
      // Completion: 26/30 ≈ 0.867, Reliability: same
      expect(result.dimensions.completion).toBeCloseTo(26 / 30);
      expect(result.dimensions.reliability).toBeCloseTo(1 - 4 / 30);
    });

    it('merges quality by weighted average', () => {
      const local: RatingEntry = {
        skillName: 'weather',
        dimensions: { completion: 1, quality: 3.0, reliability: 1, latency: 1, tokenCost: 1 },
        invocations: 10,
        lastInvoked: '2026-04-16T00:00:00Z',
        recentFeedback: Array(10).fill({ id: 'a', timestamp: '', positive: true, source: 'cli' }) as FeedbackEntry[],
        metrics: { totalSuccess: 10, totalErrors: 0, avgLatencyMs: 0, p95LatencyMs: 0, avgTokenCost: 0 },
      };
      const cloud: RatingEntry = {
        skillName: 'weather',
        dimensions: { completion: 1, quality: 4.0, reliability: 1, latency: 1, tokenCost: 1 },
        invocations: 20,
        lastInvoked: '2026-04-17T00:00:00Z',
        recentFeedback: Array(20).fill({ id: 'b', timestamp: '', positive: true, source: 'web' }) as FeedbackEntry[],
        metrics: { totalSuccess: 20, totalErrors: 0, avgLatencyMs: 0, p95LatencyMs: 0, avgTokenCost: 0 },
      };
      const result = mergeRatings(local, cloud);
      expect(result.dimensions.quality).toBeCloseTo(3.667, 1);
    });
  });

  describe('mergeFeedback', () => {
    it('deduplicates by feedback ID', () => {
      const local: FeedbackEntry[] = [
        { id: 'abc', timestamp: '2026-04-17T01:00:00Z', positive: true, source: 'cli' },
      ];
      const cloud: FeedbackEntry[] = [
        { id: 'abc', timestamp: '2026-04-17T01:00:00Z', positive: true, source: 'cli' },
        { id: 'def', timestamp: '2026-04-17T02:00:00Z', positive: false, source: 'web' },
      ];
      const result = mergeFeedback(local, cloud);
      expect(result).toHaveLength(2);
      expect(result.map(f => f.id).sort()).toEqual(['abc', 'def']);
    });

    it('returns all entries when no overlap', () => {
      const local: FeedbackEntry[] = [
        { id: 'a1', timestamp: '', positive: true, source: 'cli' },
      ];
      const cloud: FeedbackEntry[] = [
        { id: 'b1', timestamp: '', positive: false, source: 'web' },
      ];
      const result = mergeFeedback(local, cloud);
      expect(result).toHaveLength(2);
    });
  });
});
