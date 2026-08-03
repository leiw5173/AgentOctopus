import type { SandboxResultMeta } from '@agentoctopus/sandbox';

/** Per-request telemetry carrier threaded through Router/Executor/SandboxRunner.
 *  Does NOT change AdapterResult/ExecutionResult shapes. All fields optional so
 *  CLI (no telemetry) can omit the context entirely. */
export interface ExecutionContext {
  traceId?: string;        // correlation key (oct-e2e-<uuid>) extracted by gateway /ask
  executionId?: string;    // stable per logical execution (one run() or one spawn() session)
  apiKeyId?: string;       // caller identity (hashed key id), never the raw key
  receivedAt?: number;     // request start (ms epoch)
}

export interface SandboxCompletedEvent {
  kind: 'sandbox.completed';
  traceId?: string; executionId: string;
  meta: SandboxResultMeta; exitCode: number | null; sandboxSuccess: boolean;
  /** STATIC emitter-site label, NOT derived from sandboxSuccess:
   *  'created' only on the spawn-created event (right after backend.spawn
   *  succeeds); 'final' on run() complete/error AND spawn-close. The
   *  aggregator treats 'final' as closing its runs[] element regardless of
   *  sandboxSuccess. */
  phase: 'created' | 'final';
}
export interface AdapterCompletedEvent {
  kind: 'adapter.completed';
  traceId?: string; executionId: string;
  adapterSuccess: boolean; errorCode: string | null;
  outputValidated: boolean; outputValidationReason: string | null;
}
export interface RequestTerminalEvent {
  kind: 'request.completed' | 'request.failed';
  traceId: string; reason: string | null;
}
export interface RoutingCompletedEvent {
  kind: 'routing.completed';
  traceId?: string;
  intent: string; intentSource: 'llm' | 'original-query-fallback'; intentExtractionSucceeded: boolean;
  candidatesConsidered: number;
  selected: string | null; selectedRawScore: number | null; normalizedConfidence: number | null;
  candidates: Array<{ name: string; rawScore: number }>;
  selectionMethod: 'reranker' | 'score-fallback'; selectedCandidateRank: number | null;
}
export type TelemetryEvent =
  | SandboxCompletedEvent | AdapterCompletedEvent | RequestTerminalEvent | RoutingCompletedEvent;

export interface TelemetrySink { emit(event: TelemetryEvent): void; }
