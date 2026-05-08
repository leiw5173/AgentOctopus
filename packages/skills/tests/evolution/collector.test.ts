import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { recordSignal, getSignalsSince } from '../../src/evolution/collector.js';
import type { EvolutionSignal } from '../../src/evolution/types.js';

describe('recordSignal', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-collector-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends one line of JSON to signals.jsonl', () => {
    const evolutionDir = path.join(tmpDir, '.evolution');
    recordSignal(evolutionDir, {
      ts: '2026-05-08T10:00:00.000Z',
      type: 'invocation',
      success: true,
      latencyMs: 320,
      tokenUsage: 180,
    });

    const filePath = path.join(evolutionDir, 'signals.jsonl');
    expect(fs.existsSync(filePath)).toBe(true);
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe('invocation');
    expect(parsed.success).toBe(true);
  });

  it('appends multiple signals sequentially', () => {
    const evolutionDir = path.join(tmpDir, '.evolution');
    recordSignal(evolutionDir, { ts: '2026-05-08T10:00:00Z', type: 'invocation', success: true, latencyMs: 100, tokenUsage: 50 });
    recordSignal(evolutionDir, { ts: '2026-05-08T10:01:00Z', type: 'feedback', positive: false, comment: 'wrong output' });
    recordSignal(evolutionDir, { ts: '2026-05-08T10:02:00Z', type: 'invocation', success: false, latencyMs: 5000, error: 'timeout' });

    const filePath = path.join(evolutionDir, 'signals.jsonl');
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
  });

  it('creates .evolution directory if it does not exist', () => {
    const evolutionDir = path.join(tmpDir, '.evolution');
    expect(fs.existsSync(evolutionDir)).toBe(false);
    recordSignal(evolutionDir, { ts: '2026-05-08T10:00:00Z', type: 'invocation', success: true, latencyMs: 100, tokenUsage: 50 });
    expect(fs.existsSync(evolutionDir)).toBe(true);
  });
});

describe('getSignalsSince', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-signals-since-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns signals after the given timestamp', () => {
    const evolutionDir = path.join(tmpDir, '.evolution');
    const now = Date.now();

    const signals: EvolutionSignal[] = [
      { ts: new Date(now - 3000).toISOString(), type: 'invocation', success: true, latencyMs: 100, tokenUsage: 50 },
      { ts: new Date(now - 2000).toISOString(), type: 'feedback', positive: true },
      { ts: new Date(now - 1000).toISOString(), type: 'invocation', success: false, latencyMs: 500, error: 'err' },
    ];

    for (const s of signals) {
      recordSignal(evolutionDir, s);
    }

    const since = new Date(now - 2500).toISOString();
    const recent = getSignalsSince(evolutionDir, since);
    expect(recent.length).toBe(2);
    expect(recent[0].type).toBe('feedback');
    expect(recent[1].type).toBe('invocation');
    expect(recent[1].success).toBe(false);
  });

  it('returns empty array when file does not exist', () => {
    const result = getSignalsSince(path.join(tmpDir, 'nonexistent', '.evolution'), new Date().toISOString());
    expect(result).toEqual([]);
  });
});
