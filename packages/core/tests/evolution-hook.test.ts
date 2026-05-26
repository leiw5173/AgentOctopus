import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('../src/config-resolver.js', () => ({
  getConfig: vi.fn(() => ({
    evolution: { enabled: true, signalThreshold: 3, feedbackThreshold: 2 },
  })),
}));

import { recordExecutionSignal, shouldTriggerAnalysis } from '../src/evolution-hook.js';
import { getConfig } from '../src/config-resolver.js';

describe('recordExecutionSignal', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-hook-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes invocation signal to skills .evolution dir', () => {
    recordExecutionSignal(tmpDir, true, 200, 100, null);

    const filePath = path.join(tmpDir, '.evolution', 'signals.jsonl');
    expect(fs.existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8').trim());
    expect(parsed.type).toBe('invocation');
    expect(parsed.success).toBe(true);
    expect(parsed.latencyMs).toBe(200);
    expect(parsed.tokenUsage).toBe(100);
  });

  it('skips when evolution disabled', () => {
    vi.mocked(getConfig).mockReturnValueOnce({
      evolution: { enabled: false, signalThreshold: 3, feedbackThreshold: 2 },
    } as any);

    recordExecutionSignal(tmpDir, true, 200, 100, null);

    const filePath = path.join(tmpDir, '.evolution', 'signals.jsonl');
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

describe('shouldTriggerAnalysis', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-trigger-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns true when signals exceed threshold', () => {
    const evolutionDir = path.join(tmpDir, '.evolution');
    fs.mkdirSync(evolutionDir, { recursive: true });
    const now = new Date('2026-05-08T10:00:00Z').toISOString();
    const later = new Date('2026-05-08T10:05:00Z').toISOString();

    fs.writeFileSync(
      path.join(evolutionDir, 'signals.jsonl'),
      [
        JSON.stringify({ ts: now, type: 'invocation', success: true, latencyMs: 100, tokenUsage: 50 }),
        JSON.stringify({ ts: later, type: 'invocation', success: false, latencyMs: 200, tokenUsage: 30, error: 'timeout' }),
        JSON.stringify({ ts: later, type: 'invocation', success: true, latencyMs: 150, tokenUsage: 40 }),
      ].join('\n') + '\n',
    );

    expect(shouldTriggerAnalysis(tmpDir, '2026-05-08T10:04:00Z')).toBe(false); // only 2 after 10:04

    // all 3 are after initial time
    expect(shouldTriggerAnalysis(tmpDir, new Date(0).toISOString())).toBe(true);
  });

  it('returns false when evolution disabled', () => {
    vi.mocked(getConfig).mockReturnValueOnce({
      evolution: { enabled: false, signalThreshold: 3, feedbackThreshold: 2 },
    } as any);

    expect(shouldTriggerAnalysis(tmpDir, new Date(0).toISOString())).toBe(false);
  });

  it('returns true when negative feedback exceeds feedbackThreshold', () => {
    const evolutionDir = path.join(tmpDir, '.evolution');
    fs.mkdirSync(evolutionDir, { recursive: true });
    const ts = new Date().toISOString();

    // Write 2 negative feedback entries (threshold is 2)
    fs.writeFileSync(
      path.join(evolutionDir, 'signals.jsonl'),
      [
        JSON.stringify({ ts, type: 'feedback', positive: false, comment: 'wrong result' }),
        JSON.stringify({ ts, type: 'feedback', positive: false, comment: 'failed again' }),
      ].join('\n') + '\n',
    );

    expect(shouldTriggerAnalysis(tmpDir, new Date(0).toISOString())).toBe(true);
  });
});
