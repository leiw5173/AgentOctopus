/**
 * Sandboxed launch — TS wrapper for the helper's `run` subcommand.
 *
 * Spawns
 *   octopus-sandbox-helper.exe run --job <name> --mem-mb <n> --pkg <moniker>
 *     --proxy <url> --ca <path> --bootstrap <path> --node <nodePath>
 *     [--restricted-token] -- <argv...>
 * which creates the Job object and, in the production mode, launches the child
 * node.exe under a CreateRestrictedToken-hardened token (no AppContainer /
 * LPAC), relays stdio, and exits with the child's exit code.
 *
 * PRODUCTION MODE (Option 3): pass `restrictedToken: true`. The helper then
 * builds a hardened restricted token (privileges stripped, Administrators
 * deny-only, Low integrity) and launches via CreateProcessAsUserW — NO LPAC
 * profile, NO AppContainer token. The legacy LPAC path is DIAGNOSTIC-ONLY
 * (the LPAC selftest baseline); production always uses restricted-token.
 * `pkgMoniker` is still passed (the helper requires it for the LPAC diagnostic
 * baseline + selftest), but the restricted-token path ignores the LPAC profile
 * creation.
 *
 * PROXY SCHEME CONTRACT (Task 7 -> Task 8/10 deferral, resolved TS-side):
 * helper.c passes its --proxy value VERBATIM into the child's
 * HTTP_PROXY/HTTPS_PROXY env block (helper.c build_env_block, ~608-630), and
 * spec §4d mandates that value be a scheme-qualified URL
 * ("http://127.0.0.1:<port>") — the runtime bootstrap
 * (images/runtime/bootstrap.cjs) hands it straight to undici's ProxyAgent as
 * `uri`. The helper does NO scheme normalization, so THIS wrapper owns it:
 * `proxy` may be given as a bare "host:port" (or {host, port}) and is
 * normalized to "http://host:port" before being passed to --proxy.
 *
 * Fail-closed: a spawn failure throws WindowsSandboxError. A non-zero helper
 * exit (child failure included) is returned as {exitCode, stdout, stderr}
 * for the caller to inspect — the exit code IS the sandboxed child's code,
 * relayed verbatim by the helper.
 *
 * This module is leaf-package production code: Node stdlib only.
 */
import { WindowsSandboxError } from './errors.js';
import { spawnHelper, type HelperSpawnOptions, type HelperResult } from './helper-spawn.js';

export interface LaunchSandboxedArgs {
  jobName: string;
  memMb: number;
  /**
   * Session package moniker. Still required by the helper for the LPAC
   * diagnostic baseline + selftest; the restricted-token production path passes
   * it through but ignores the LPAC profile creation.
   */
  pkgMoniker: string;
  /**
   * PRODUCTION MODE (Option 3): when true, append `--restricted-token` so the
   * helper launches node under a CreateRestrictedToken-hardened token (no
   * LPAC). LPAC is diagnostic-only; production always sets this true.
   */
  restrictedToken: boolean;
  /** Egress proxy endpoint: "host:port", {host, port}, or a full URL. */
  proxy: string | { host: string; port: number };
  caPath: string;
  bootstrapPath: string;
  nodePath: string;
  argv: string[];
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Normalize a proxy endpoint to a scheme-qualified http:// URL. The helper
 * injects whatever it receives verbatim into HTTP_PROXY/HTTPS_PROXY, and the
 * runtime ProxyAgent needs a parseable URL (spec §4d).
 */
export function normalizeProxyUrl(proxy: LaunchSandboxedArgs['proxy']): string {
  const hostPort =
    typeof proxy === 'string'
      ? proxy
      : `${proxy.host}:${proxy.port}`;
  if (hostPort.length === 0) {
    throw new WindowsSandboxError('proxy must be a non-empty host:port');
  }
  if (SCHEME_RE.test(hostPort)) return hostPort;
  return `http://${hostPort}`;
}

/**
 * Launch a sandboxed child via the helper's `run` subcommand. Resolves with
 * the relayed {exitCode, stdout, stderr}; throws WindowsSandboxError only
 * when the helper exe itself cannot be spawned (missing binary or a
 * non-Windows host).
 */
export async function launchSandboxed(
  args: LaunchSandboxedArgs,
  opts?: HelperSpawnOptions,
): Promise<HelperResult> {
  const proxyUrl = normalizeProxyUrl(args.proxy);
  if (typeof args.jobName !== 'string' || args.jobName.length === 0) {
    throw new WindowsSandboxError('jobName must be a non-empty string');
  }
  if (!Number.isInteger(args.memMb) || args.memMb <= 0) {
    throw new WindowsSandboxError(`memMb must be a positive integer, got: ${args.memMb}`);
  }
  if (!Array.isArray(args.argv)) {
    throw new WindowsSandboxError('argv must be an array of strings');
  }
  const argv = [
    'run',
    '--job', args.jobName,
    '--mem-mb', String(args.memMb),
    '--pkg', args.pkgMoniker,
    '--proxy', proxyUrl,
    '--ca', args.caPath,
    '--bootstrap', args.bootstrapPath,
    '--node', args.nodePath,
    // Option-3 production mode: launch under a hardened restricted token, no
    // LPAC. Placed immediately before the `--` separator.
    ...(args.restrictedToken ? ['--restricted-token'] : []),
    // Run-12: create the named Job in the Global object namespace so the
    // session-0 gate service can open it and refuse remove-gate while the
    // Job is alive (a session-Local name is invisible to the service, which
    // would read it as already-dead and allow removal). Production always
    // sets this; it pairs with the restricted-token production mode.
    '--global-job',
    '--',
    ...args.argv,
  ];
  return spawnHelper(argv, opts);
}
