import { describe, it, expect } from 'vitest';
import type { ExecutionContext, TelemetrySink, TelemetryEvent } from '../src/execution-context.js';

describe('ExecutionContext / TelemetrySink', () => {
  it('supports a sink emitting a sandbox.completed event', () => {
    const seen: TelemetryEvent[] = [];
    const sink: TelemetrySink = { emit: (e) => seen.push(e) };
    const ctx: ExecutionContext = { traceId: 'oct-e2e-x', executionId: 'exec-1' };
    sink.emit({ kind: 'sandbox.completed', traceId: ctx.traceId, executionId: ctx.executionId!, meta: { isolationLevel: 'full', backend: 'docker', degraded: false, degradationReasons: [] }, exitCode: 0, sandboxSuccess: true, phase: 'final' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.kind).toBe('sandbox.completed');
  });
});
