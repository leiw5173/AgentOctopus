import type { LoadedSkill } from '@agentoctopus/registry';
import type { BackendKind, IsolationLevel, SandboxProcess } from '@agentoctopus/sandbox';

export interface AdapterResult {
  success: boolean;
  data?: unknown;
  error?: string;
  rawText?: string;
}

/**
 * The skill + payload an adapter is asked to execute. The skill is trusted
 * metadata (manifest + dirPath) — the adapter NEVER spawns or fetches on the
 * host from it; it only serializes a guest command/request for the sandbox.
 */
export interface AdapterInput {
  skill: LoadedSkill;
  input: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// BoundSandboxExecutionPort (STRUCTURAL — Plan 5 Task 4)
//
// This is the one execution boundary every non-MCP adapter converges on. It is
// declared HERE (in the adapters package) as a structural interface that uses
// ONLY sandbox contract types + primitives — never core, never registry beyond
// the trusted LoadedSkill metadata. Core's exported BoundSandboxExecutionPort
// (packages/core/src/sandbox-runner.ts) is structurally assignable to this:
// `sandboxRunner.bind(skill)` returns exactly this shape.
// ---------------------------------------------------------------------------

export interface SandboxRunOutput {
  success: boolean;
  rawText?: string;
  stderr?: string;
  error?: string;
  isolationLevel: IsolationLevel;
  backend: BackendKind | 'none';
}

export interface SandboxSessionHandle {
  readonly process: SandboxProcess;
  readonly isolationLevel: IsolationLevel;
  readonly backend: BackendKind;
  close(): Promise<void>;
}

export interface SandboxInvocationPayload {
  payload?: unknown;
  stdin?: string | Uint8Array;
  env?: Record<string, string>;
}

export interface SandboxCommandRequest {
  command: string[];
  invocation?: SandboxInvocationPayload;
  timeoutMs?: number;
}

export interface BoundSandboxExecutionPort {
  run(input: SandboxCommandRequest): Promise<SandboxRunOutput>;
  spawn(
    input: Omit<SandboxCommandRequest, 'invocation'> & {
      invocation?: Omit<SandboxInvocationPayload, 'stdin'>;
    },
  ): Promise<SandboxSessionHandle>;
}

/**
 * The required invocation context core injects into every adapter call. The
 * sandbox port is ALREADY bound to the skill (via `sandboxRunner.bind(skill)`),
 * so the adapter receives a ready-to-use execution boundary and never needs —
 * and never gets — host process/network access.
 */
export interface AdapterInvocationContext {
  sandbox: BoundSandboxExecutionPort; // required, already bound to the skill in core
  payload: unknown;
  timeoutMs: number;
}

export interface Adapter {
  invoke(input: AdapterInput, context: AdapterInvocationContext): Promise<AdapterResult>;
}
