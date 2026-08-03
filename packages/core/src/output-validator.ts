/**
 * Injected async output validation (T3.4).
 *
 * The Executor optionally runs a caller-supplied validator against a
 * SUCCESSFUL AdapterResult before emitting `adapter.completed`. The validator
 * is fully async and bounded by `runOutputValidator`'s `timeoutMs` — a hung
 * validator must never stall the executor, and its failure mode must be
 * surfaced as a structured reason on the telemetry event, never as a thrown
 * exception that breaks execute().
 */

/**
 * Caller-injected output validator. Receives the adapter's success flag and
 * optional payload (rawText / parsed data); returns ok plus an optional
 * machine-readable reason. NEVER throws — `runOutputValidator` guards.
 */
export type OutputValidator = (output: {
  success: boolean;
  rawText?: string;
  data?: unknown;
}) => Promise<{ ok: boolean; reason?: string }>;

/**
 * Race an OutputValidator against a timeout. Outcomes:
 *   - resolves {ok:true}               → { ok:true,  reason:null }
 *   - resolves {ok:false, reason}      → { ok:false, reason }
 *   - rejects / throws                 → { ok:false, reason:<error message> }
 *   - exceeds timeoutMs                → { ok:false, reason:'validator timeout' }
 *
 * The timeout timer is cleared on resolution so the process can exit.
 */
export async function runOutputValidator(
  v: OutputValidator,
  output: { success: boolean; rawText?: string; data?: unknown },
  timeoutMs: number,
): Promise<{ ok: boolean; reason: string | null }> {
  let timer: NodeJS.Timeout | null = null;
  try {
    const timeout = new Promise<{ ok: boolean; reason: string }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, reason: 'validator timeout' }), timeoutMs);
    });
    const result = await Promise.race([v(output), timeout]);
    if (result.ok) return { ok: true, reason: null };
    return { ok: false, reason: result.reason ?? 'validator reported invalid' };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
