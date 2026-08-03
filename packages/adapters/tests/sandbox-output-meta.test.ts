/**
 * Adapter-facing SandboxRunOutput / SandboxSessionHandle result-meta shape
 * (T3). Asserts that:
 *
 *   - a `SandboxRunOutput` literal WITH `meta` type-checks through the
 *     adapter-facing types.
 *   - `SandboxSessionHandle` accepts an optional `resultMeta` mirror.
 *   - a literal WITHOUT `meta` is a compile-time error (covered structurally
 *     by the `@ts-expect-error` assertion below — if the field were optional
 *     this file would fail typecheck).
 *
 * The four adapter test fixtures (mcp-session, mcp-sandbox, http-sandbox,
 * subprocess-sandbox) all carry `meta` after T3; this file pins the contract.
 */
import { describe, it, expect } from 'vitest';
import type {
  SandboxRunOutput,
  SandboxSessionHandle,
} from '../src/adapter.js';
import type { SandboxResultMeta } from '@agentoctopus/sandbox';

describe('adapter-facing SandboxRunOutput meta shape (T3)', () => {
  it('literal with meta type-checks and is readable', () => {
    const out: SandboxRunOutput = {
      success: true,
      rawText: '{"ok":true}',
      isolationLevel: 'full',
      backend: 'docker',
      meta: {
        isolationLevel: 'full',
        backend: 'docker',
        degraded: false,
        degradationReasons: [],
      },
    };
    expect(out.meta.isolationLevel).toBe('full');
    expect(out.meta.backend).toBe('docker');
    expect(out.meta.degraded).toBe(false);
    expect(out.meta.degradationReasons).toEqual([]);
  });

  it('meta is REQUIRED: a literal missing meta is a compile error', () => {
    // @ts-expect-error — meta is required on SandboxRunOutput
    const missing: SandboxRunOutput = {
      success: true,
      isolationLevel: 'full',
      backend: 'docker',
    };
    // Runtime no-op — the assertion is the compile-time error above.
    void missing;
  });

  it('SandboxSessionHandle accepts an optional resultMeta mirror', () => {
    const meta: SandboxResultMeta = {
      isolationLevel: 'restricted',
      backend: 'os',
      degraded: true,
      degradationReasons: ['darwin-restricted-lane'],
    };
    const handle: SandboxSessionHandle = {
      process: undefined as never,
      isolationLevel: 'restricted',
      backend: 'os',
      resultMeta: Promise.resolve(meta),
      close: async () => {},
    };
    expect(handle.isolationLevel).toBe('restricted');
    void handle.resultMeta?.then((m) => {
      expect(m.isolationLevel).toBe('restricted');
    });
  });

  it('SandboxSessionHandle still compiles WITHOUT resultMeta (optional mirror)', () => {
    const handle: SandboxSessionHandle = {
      process: undefined as never,
      isolationLevel: 'full',
      backend: 'docker',
      close: async () => {},
    };
    expect(handle.resultMeta).toBeUndefined();
  });
});
