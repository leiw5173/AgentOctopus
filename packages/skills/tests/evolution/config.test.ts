import { describe, it, expect } from 'vitest';
import { EvolutionConfigSchema } from '../../../core/src/config-types.js';

describe('EvolutionConfigSchema', () => {
  it('fills defaults when no fields provided', () => {
    const result = EvolutionConfigSchema.parse({});
    expect(result.enabled).toBe(false);
    expect(result.autoApplySafe).toBe(true);
    expect(result.signalThreshold).toBe(10);
    expect(result.feedbackThreshold).toBe(3);
    expect(result.staleDays).toBe(30);
    expect(result.maxHistorySnapshots).toBe(20);
    expect(result.scheduleCron).toBe('0 3 * * *');
  });

  it('preserves explicit overrides', () => {
    const result = EvolutionConfigSchema.parse({
      enabled: true,
      signalThreshold: 5,
      staleDays: 14,
    });
    expect(result.enabled).toBe(true);
    expect(result.signalThreshold).toBe(5);
    expect(result.staleDays).toBe(14);
    expect(result.feedbackThreshold).toBe(3); // default still applied
  });

  it('rejects invalid types', () => {
    expect(() => EvolutionConfigSchema.parse({ enabled: 'yes' })).toThrow();
    expect(() => EvolutionConfigSchema.parse({ signalThreshold: -1 })).toThrow();
  });
});
