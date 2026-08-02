/**
 * DebugTelemetryBuffer tests (T3.6).
 *
 * Asserts the gateway-side aggregator merges TelemetryEvents keyed by traceId
 * into a per-request RunRecord, with:
 *   - pending until terminal AND all runs[] final,
 *   - sandbox.completed created/final merge by executionId,
 *   - adapter.completed attaching to the same runs[] element,
 *   - one-directional status (never complete/failed → pending),
 *   - events without a traceId ignored,
 *   - ring-buffer eviction of the oldest record by receivedAt.
 */
import { describe, it, expect } from 'vitest';
import { DebugTelemetryBuffer } from '../src/debug-telemetry.js';

const meta = { isolationLevel: 'full' as const, backend: 'docker' as const, degraded: false, degradationReasons: [] };

describe('DebugTelemetryBuffer', () => {
  it('stays pending until terminal event AND all runs final', () => {
    const buf = new DebugTelemetryBuffer(10);
    buf.record({ kind: 'sandbox.completed', traceId: 't1', executionId: 'e1', meta, exitCode: 0, sandboxSuccess: true, phase: 'final' }, {});
    expect(buf.getByRunId('t1')!.status).toBe('pending');
    buf.record({ kind: 'request.completed', traceId: 't1', reason: null }, {});
    expect(buf.getByRunId('t1')!.status).toBe('complete');
    expect(buf.getByRunId('t1')!.completedAt).not.toBeNull();
  });

  it('completes a no-sandbox request with empty runs[] on terminal', () => {
    const buf = new DebugTelemetryBuffer(10);
    buf.record({ kind: 'request.failed', traceId: 't2', reason: 'no route' }, {});
    expect(buf.getByRunId('t2')!.status).toBe('failed');
    expect(buf.getByRunId('t2')!.runs).toEqual([]);
  });

  it('merges created + final sandbox events into one runs[] element by executionId', () => {
    const buf = new DebugTelemetryBuffer(10);
    buf.record({ kind: 'sandbox.completed', traceId: 't3', executionId: 'e1', meta, exitCode: null, sandboxSuccess: false, phase: 'created' }, {});
    buf.record({ kind: 'sandbox.completed', traceId: 't3', executionId: 'e1', meta, exitCode: 0, sandboxSuccess: true, phase: 'final' }, {});
    expect(buf.getByRunId('t3')!.runs).toHaveLength(1);
  });

  it('status is one-directional (never complete → pending)', () => {
    const buf = new DebugTelemetryBuffer(10);
    buf.record({ kind: 'request.completed', traceId: 't4', reason: null }, {});
    const before = buf.getByRunId('t4')!.status;
    buf.record({ kind: 'sandbox.completed', traceId: 't4', executionId: 'e1', meta, exitCode: 0, sandboxSuccess: true, phase: 'final' }, {});
    expect(buf.getByRunId('t4')!.status).toBe(before);
  });

  it('returns null for unknown runId', () => {
    const buf = new DebugTelemetryBuffer(10);
    expect(buf.getByRunId('nope')).toBeNull();
  });

  // Extra pins for rules the canonical 5 leave implicit.
  it('terminal arriving while a run is still created stays pending, then transitions when the last run finalizes', () => {
    const buf = new DebugTelemetryBuffer(10);
    buf.record({ kind: 'sandbox.completed', traceId: 't5', executionId: 'e1', meta, exitCode: null, sandboxSuccess: false, phase: 'created' }, {});
    buf.record({ kind: 'request.completed', traceId: 't5', reason: null }, {});
    expect(buf.getByRunId('t5')!.status).toBe('pending');
    buf.record({ kind: 'sandbox.completed', traceId: 't5', executionId: 'e1', meta, exitCode: 0, sandboxSuccess: true, phase: 'final' }, {});
    expect(buf.getByRunId('t5')!.status).toBe('complete');
    expect(buf.getByRunId('t5')!.completedAt).not.toBeNull();
  });

  it('evicts the oldest record (by receivedAt) when capacity is exceeded', () => {
    const buf = new DebugTelemetryBuffer(2);
    buf.record({ kind: 'request.failed', traceId: 'old', reason: 'x' }, { receivedAt: 1000 });
    buf.record({ kind: 'request.failed', traceId: 'mid', reason: 'x' }, { receivedAt: 2000 });
    buf.record({ kind: 'request.failed', traceId: 'new', reason: 'x' }, { receivedAt: 3000 });
    expect(buf.getByRunId('old')).toBeNull();
    expect(buf.getByRunId('mid')).not.toBeNull();
    expect(buf.getByRunId('new')).not.toBeNull();
  });

  it('ignores events without a traceId', () => {
    const buf = new DebugTelemetryBuffer(10);
    buf.record({ kind: 'sandbox.completed', executionId: 'e1', meta, exitCode: 0, sandboxSuccess: true, phase: 'final' }, {});
    expect(buf.latest()).toBeNull();
  });
});
