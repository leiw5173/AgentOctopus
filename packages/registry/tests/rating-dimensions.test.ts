import { describe, it, expect } from 'vitest';
import {
  computeRoutingScore,
  getWeightsForTaskType,
  type RatingDimensions,
  type TaskType,
} from '../src/rating-dimensions.js';

describe('rating-dimensions', () => {
  describe('getWeightsForTaskType', () => {
    it('returns one-shot weights by default', () => {
      const w = getWeightsForTaskType('one-shot');
      expect(w.completion).toBeCloseTo(0.30);
      expect(w.quality).toBeCloseTo(0.25);
      expect(w.reliability).toBeCloseTo(0.20);
      expect(w.latency).toBeCloseTo(0.15);
      expect(w.tokenCost).toBeCloseTo(0.10);
    });

    it('returns long-running weights', () => {
      const w = getWeightsForTaskType('long-running');
      expect(w.completion).toBeCloseTo(0.25);
      expect(w.quality).toBeCloseTo(0.20);
      expect(w.reliability).toBeCloseTo(0.30);
      expect(w.latency).toBeCloseTo(0.10);
      expect(w.tokenCost).toBeCloseTo(0.15);
    });

    it('returns agent-collab weights', () => {
      const w = getWeightsForTaskType('agent-collab');
      expect(w.completion).toBeCloseTo(0.20);
      expect(w.quality).toBeCloseTo(0.30);
      expect(w.reliability).toBeCloseTo(0.25);
      expect(w.latency).toBeCloseTo(0.10);
      expect(w.tokenCost).toBeCloseTo(0.15);
    });

    it('weights sum to 1.0 for all task types', () => {
      for (const tt of ['one-shot', 'long-running', 'agent-collab'] as TaskType[]) {
        const w = getWeightsForTaskType(tt);
        const sum = w.completion + w.quality + w.reliability + w.latency + w.tokenCost;
        expect(sum).toBeCloseTo(1.0);
      }
    });
  });

  describe('computeRoutingScore', () => {
    const dims: RatingDimensions = {
      completion: 0.90,
      quality: 3.2,
      reliability: 0.88,
      latency: 0.85,
      tokenCost: 0.90,
    };

    it('computes score for one-shot task type', () => {
      const score = computeRoutingScore(dims, 'one-shot');
      expect(score).toBeCloseTo(0.8235, 3);
    });

    it('returns 0 for all-zero dimensions', () => {
      const zero: RatingDimensions = {
        completion: 0, quality: 0, reliability: 0, latency: 0, tokenCost: 0,
      };
      expect(computeRoutingScore(zero, 'one-shot')).toBeCloseTo(0);
    });

    it('returns 1 for perfect dimensions', () => {
      const perfect: RatingDimensions = {
        completion: 1, quality: 5, reliability: 1, latency: 1, tokenCost: 1,
      };
      expect(computeRoutingScore(perfect, 'one-shot')).toBeCloseTo(1);
    });

    it('clamps result to 0-1', () => {
      const weird: RatingDimensions = {
        completion: 1.5, quality: 10, reliability: 2, latency: 1, tokenCost: 1,
      };
      const score = computeRoutingScore(weird, 'one-shot');
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });
});
