import { describe, it, expect } from 'vitest';
import { buildAnalysisPrompt, buildStaleAnalysisPrompt, parseAnalyzerResponse } from '../../src/evolution/analyzer.js';
import type { EvolutionSignal } from '../../src/evolution/types.js';

describe('buildAnalysisPrompt', () => {
  it('produces a prompt containing skill content and signal summary', () => {
    const skillMd = '---\nname: weather\ndescription: Get weather data\n---\n\n# Weather\n\nCall curl wttr.in/city';
    const signals: EvolutionSignal[] = [
      { ts: '2026-05-08T10:00:00Z', type: 'invocation', success: false, latencyMs: 5000, tokenUsage: 0, error: 'timeout' },
      { ts: '2026-05-08T10:01:00Z', type: 'feedback', positive: false, comment: 'wrong API called' },
    ];

    const prompt = buildAnalysisPrompt('weather', 'completion dropped from 0.9 to 0.4', skillMd, signals);
    expect(prompt).toContain('weather');
    expect(prompt).toContain('completion dropped');
    expect(prompt).toContain('Get weather data');
    expect(prompt).toContain('timeout');
    expect(prompt).toContain('wrong API called');
    expect(prompt).toContain('safe');
    expect(prompt).toContain('risky'); // risk tier instructions
  });
});

describe('buildStaleAnalysisPrompt', () => {
  it('produces a lightweight prompt for stale skill', () => {
    const skillMd = '---\nname: translation\ndescription: Translate text\n---\n\n# Translation';
    const prompt = buildStaleAnalysisPrompt('translation', skillMd, 47);
    expect(prompt).toContain('translation');
    expect(prompt).toContain('47 days');
    expect(prompt).toContain('description');
  });
});

describe('parseAnalyzerResponse', () => {
  it('parses a valid LLM response with safe and risky changes', () => {
    const response = `EVIDENCE: completion rate dropped due to missing URL encoding in curl calls

CHANGE:
FIELD: description
RISK: safe
ORIGINAL: Get weather data.
PROPOSED: Get current weather, forecasts, and astronomical data for any city worldwide.
RATIONALE: broader keywords improve routing precision

CHANGE:
FIELD: instructions
RISK: risky
ORIGINAL: Call curl wttr.in/city
PROPOSED: Call curl -s "wttr.in/$(python3 -c "import urllib.parse; print(urllib.parse.quote(city))")"
RATIONALE: add URL encoding to handle city names with spaces`;

    const result = parseAnalyzerResponse(response, 'weather');
    expect(result.evidence).toContain('missing URL encoding');
    expect(result.changes).toHaveLength(2);
    expect(result.changes[0].field).toBe('description');
    expect(result.changes[0].risk).toBe('safe');
    expect(result.changes[1].field).toBe('instructions');
    expect(result.changes[1].risk).toBe('risky');
  });

  it('returns empty changes when no CHANGE blocks found', () => {
    const result = parseAnalyzerResponse('No changes needed', 'weather');
    expect(result.changes).toHaveLength(0);
  });

  it('skips malformed CHANGE blocks', () => {
    const response = `CHANGE:
FIELD: description
RISK: safe
ORIGINAL: old
MISSING PROPOSED and RATIONALE`;

    const result = parseAnalyzerResponse(response, 'weather');
    expect(result.changes).toHaveLength(0); // missing PROPOSED
  });
});
