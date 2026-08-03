/**
 * Guest environment construction (fail-closed credential containment).
 *
 * The VM must NOT inherit caller-supplied env vars wholesale: a skill's
 * `spec.env` is untrusted, and merging it through verbatim leaks any host
 * credential the caller happened to hold (the L4 credential-leak escape
 * vector). The OS sandbox already enforces this contract — its helper clears
 * the environment and installs only a tiny SAFE allowlist (see lane-probe.ts
 * header). This module gives the VM backend the same guarantee.
 *
 * Only an explicit SAFE allowlist of probe-orchestration var NAMES survives
 * from `spec.env`; everything else is dropped. The trusted proxy/CA overrides
 * are then applied unconditionally (they win on any collision), so the guest
 * always egresses via the sidecar proxy with the session CA — never a
 * caller-supplied proxy or CA.
 */

/**
 * Env var NAMES permitted to pass from untrusted `spec.env` into the guest.
 * These are the lane-probe orchestration inputs the security lanes rely on
 * (see lane-probe.ts): the probe action, the net-probe target host/port, and
 * the host-canary path the G1 gate asserts is unreachable. They carry no
 * secrets — HOST_CANARY_PATH is a path to a file the guest must NOT be able
 * to read, and the PROBE_* vars select which probe action runs. Anything not
 * listed here (including every `*_KEY` / `*_SECRET` / canary credential) is
 * stripped.
 */
const SAFE_ENV_ALLOWLIST = new Set(['PROBE_ACTION', 'PROBE_HOST', 'PROBE_PORT', 'HOST_CANARY_PATH']);

export function buildGuestEnv(
  specEnv: Record<string, string> | undefined,
  guestProxyAddr: string,
  caBundlePath: string,
): string[] {
  // Start from ONLY the allowlisted caller vars — not the whole of spec.env.
  const merged: Record<string, string> = {};
  for (const name of SAFE_ENV_ALLOWLIST) {
    const v = specEnv?.[name];
    if (v !== undefined) merged[name] = v;
  }
  // Trusted overrides (applied AFTER the allowlist so they win on collision):
  merged.HTTP_PROXY = guestProxyAddr;
  merged.HTTPS_PROXY = guestProxyAddr;
  merged.http_proxy = guestProxyAddr;
  merged.https_proxy = guestProxyAddr;
  merged.ALL_PROXY = guestProxyAddr;
  merged.all_proxy = guestProxyAddr;
  merged.NO_PROXY = '';
  merged.no_proxy = '';
  merged.SSL_CERT_FILE = caBundlePath;
  merged.NODE_EXTRA_CA_CERTS = caBundlePath;
  merged.REQUESTS_CA_BUNDLE = caBundlePath;
  return Object.entries(merged).map(([k, v]) => `${k}=${v}`);
}
