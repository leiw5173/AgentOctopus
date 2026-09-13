/**
 * Typed error for the Windows sandbox TS wrappers.
 *
 * Raised by every Windows backend call path — helper exe invocations
 * (job/sid/acl) and the gate-service named-pipe RPC (gate-client) — whenever
 * the backend fails: missing/unexecutable helper, non-zero helper exit,
 * unparsable helper output, pipe connect/read/write failure, or a
 * {"ok":false} service response.
 *
 * Fail-closed contract: no wrapper ever resolves on a failed backend call.
 *
 * This module is leaf-package production code: Node stdlib only.
 */

export class WindowsSandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WindowsSandboxError';
  }
}
