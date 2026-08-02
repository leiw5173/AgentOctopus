/**
 * DebugTelemetryBuffer (T3.6) — gateway-side aggregator for layered
 * telemetry. Merges TelemetryEvents emitted across Router / Executor /
 * SandboxRunner / terminal gateway /ask into a per-request RunRecord,
 * keyed by traceId.
 *
 * Aggregation rules (per task brief):
 *   - Events WITHOUT a traceId are ignored (non-E2E traffic).
 *   - A record is created `pending` on the FIRST event for a traceId, with
 *     `receivedAt` from ctx (fallback Date.now()) and `apiKeyId` from ctx.
 *   - routing.completed → record.routing.
 *   - sandbox.completed → merge into record.runs by executionId.
 *       phase 'created' → upsert { status:'created', sandbox } (NOT final).
 *       phase 'final'   → status:'final', overwrite sandbox.
 *   - adapter.completed → merge adapter into the runs[] element by
 *     executionId and set status:'final'.
 *   - terminal (request.completed / request.failed) → record.terminal;
 *     transition to 'complete' / 'failed' ONLY when all registered runs[]
 *     are final (empty runs[] vacuously satisfies). If terminal arrives
 *     early, store terminal but keep status 'pending'; re-evaluate on each
 *     subsequent event so the transition fires when the last run finalizes.
 *     Status is ONE-DIRECTIONAL: once 'complete'/'failed', never back to
 *     'pending'.
 *   - Ring buffer: capacity from constructor; evict OLDEST by receivedAt.
 */
import type {
  AdapterCompletedEvent,
  RequestTerminalEvent,
  RoutingCompletedEvent,
  SandboxCompletedEvent,
  TelemetryEvent,
} from '@agentoctopus/core';

export interface RunRecord {
  runId: string;
  status: 'pending' | 'complete' | 'failed';
  completedAt: number | null;
  receivedAt: number;
  apiKeyId?: string;
  queryHash?: string;      // sha256 of query (only when includeQuery=false)
  query?: string;          // only when includeQuery=true
  routing?: RoutingCompletedEvent;
  terminal?: RequestTerminalEvent;
  runs: Array<{
    executionId: string;
    status: 'created' | 'final';
    sandbox?: SandboxCompletedEvent;
    adapter?: AdapterCompletedEvent;
  }>;
}

interface RunEntry {
  executionId: string;
  status: 'created' | 'final';
  sandbox?: SandboxCompletedEvent;
  adapter?: AdapterCompletedEvent;
}

export class DebugTelemetryBuffer {
  private readonly capacity: number;
  private readonly records = new Map<string, RunRecord>();

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  record(event: TelemetryEvent, ctx: { apiKeyId?: string; receivedAt?: number }): void {
    const traceId = event.traceId;
    if (!traceId) return;

    let rec = this.records.get(traceId);
    if (!rec) {
      rec = {
        runId: traceId,
        status: 'pending',
        completedAt: null,
        receivedAt: ctx.receivedAt ?? Date.now(),
        apiKeyId: ctx.apiKeyId,
        runs: [],
      };
      this.records.set(traceId, rec);
      this.evictIfNeeded();
    }

    switch (event.kind) {
      case 'routing.completed': {
        rec.routing = event;
        break;
      }
      case 'sandbox.completed': {
        const entry = this.upsertRun(rec, event.executionId);
        if (event.phase === 'created') {
          // Do NOT mark final — the final event will close this entry.
          entry.status = 'created';
          entry.sandbox = event;
        } else {
          entry.status = 'final';
          entry.sandbox = event;
        }
        break;
      }
      case 'adapter.completed': {
        const entry = this.upsertRun(rec, event.executionId);
        entry.adapter = event;
        entry.status = 'final';
        break;
      }
      case 'request.completed':
      case 'request.failed': {
        rec.terminal = event;
        this.maybeTransition(rec, event.kind === 'request.completed' ? 'complete' : 'failed');
        break;
      }
    }

    // Re-evaluate the pending transition on every event (covers the case
    // where terminal arrived BEFORE the last run finalized).
    if (rec.status === 'pending' && rec.terminal) {
      this.maybeTransition(rec, rec.terminal.kind === 'request.completed' ? 'complete' : 'failed');
    }
  }

  getByRunId(runId: string): RunRecord | null {
    return this.records.get(runId) ?? null;
  }

  latest(): RunRecord | null {
    let latestRec: RunRecord | null = null;
    for (const rec of this.records.values()) {
      if (!latestRec || rec.receivedAt >= latestRec.receivedAt) latestRec = rec;
    }
    return latestRec;
  }

  /**
   * T3.7 — /ask-side request-start binding. Called DIRECTLY by the /ask
   * handler (NOT through the shared TelemetrySink) so per-request metadata
   * (apiKeyId, receivedAt, queryHash/query) stays out of the shared sink and
   * is never visible to other concurrent requests. Creates the record if it
   * does not yet exist (e.g. the terminal event has not fired yet); subsequent
   * record() calls for the same traceId preserve the bound metadata.
   */
  recordRequestStart(
    traceId: string,
    meta: { apiKeyId?: string; receivedAt?: number; queryHash?: string; query?: string },
  ): void {
    let rec = this.records.get(traceId);
    if (!rec) {
      rec = {
        runId: traceId,
        status: 'pending',
        completedAt: null,
        receivedAt: meta.receivedAt ?? Date.now(),
        apiKeyId: meta.apiKeyId,
        runs: [],
      };
      this.records.set(traceId, rec);
      this.evictIfNeeded();
    } else {
      if (meta.apiKeyId !== undefined) rec.apiKeyId = meta.apiKeyId;
      if (meta.receivedAt !== undefined) rec.receivedAt = meta.receivedAt;
    }
    if (meta.queryHash !== undefined) rec.queryHash = meta.queryHash;
    if (meta.query !== undefined) rec.query = meta.query;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private upsertRun(rec: RunRecord, executionId: string): RunEntry {
    let entry = rec.runs.find((r) => r.executionId === executionId);
    if (!entry) {
      entry = { executionId, status: 'created' };
      rec.runs.push(entry);
    }
    return entry;
  }

  /**
   * Transition status → target IFF record is still pending AND every runs[]
   * element is final (an empty runs[] vacuously satisfies). One-directional:
   * an already-complete/failed record is never touched.
   */
  private maybeTransition(rec: RunRecord, target: 'complete' | 'failed'): void {
    if (rec.status !== 'pending') return;
    const allFinal = rec.runs.every((r) => r.status === 'final');
    if (!allFinal) return;
    rec.status = target;
    rec.completedAt = Date.now();
  }

  private evictIfNeeded(): void {
    while (this.records.size > this.capacity) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [key, rec] of this.records) {
        if (rec.receivedAt < oldestAt) {
          oldestAt = rec.receivedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      this.records.delete(oldestKey);
    }
  }
}
