/**
 * Audited Darwin SBPL allowlist — OUTPUT OF THE T5 FEASIBILITY GATE.
 *
 * GATE VERDICT: NO-GO.
 *
 * The minimal working deny-default SBPL profile for a persistent Node/MCP
 * workload on this host (macOS 26.5.2, Darwin 25.5.0 arm64, Homebrew Node
 * v26.4.0) REQUIRES two broad, path-unfilterable grants:
 *
 *   - `(allow file-read-data)`     — required for the dyld shared cache. Proven
 *     unfilterable: no (literal …), (subpath …), or (regex …) form (including
 *     the cryptex cache directory, /System, /usr/lib, or a "dyld" regex) allows
 *     Node to start. Only the unfiltered op does. Under it, the sandboxed
 *     process reads ARBITRARY files (proven: /tmp canary and $HOME/.zshrc).
 *
 *   - `(allow file-read-metadata)` — required for Homebrew symlink resolution
 *     (the closure's /opt/homebrew/opt/* install names are symlinks). Also
 *     unfilterable to exact closure paths.
 *
 * The broad file-read-data grant trips the NO-GO criterion "broad file-read*
 * (beyond exact closure paths)" and constitutes a sandbox breakout (arbitrary
 * file read). Therefore this allowlist is committed ONLY as an audit artifact
 * recording WHY the gate failed; it MUST NOT be consumed by any trusted
 * runtime/backend. T6-T13 are blocked.
 *
 * This file is leaf-package production code: Node stdlib only (no deps).
 */

export interface DarwinSbplAllowEntry {
  op: string;
  target?: string;
  justification: string;
}

/**
 * The audited allowlist. Every entry that is broad is marked in its
 * justification. DO NOT treat this as a usable profile — see the gate record.
 */
export const DARWIN_SBPL_ALLOWLIST: readonly DarwinSbplAllowEntry[] = Object.freeze([
  {
    op: 'file-read* file-map-executable',
    target: '<enumerated verified-closure literals>',
    justification:
      'Verified Mach-O closure (enumerated via otool fixed-point, digest-pinned by the runtime manifest). Each entry is an exact literal for a verified executable/dylib/data-file path. This is the ONLY category that satisfies the enumerated-closure requirement.',
  },
  {
    op: 'process-exec*',
    target: '<trusted node executable>',
    justification: 'Only the verified Node executable may be exec’d. Exact literal.',
  },
  {
    op: 'file-read-data',
    justification:
      'NO-GO: REQUIRED IN BROAD (path-unfilterable) FORM for the dyld shared cache. Proven unfilterable by literal/subpath/regex (cryptex cache dir, /System, /usr/lib, dyld-regex all fail). Grants arbitrary file reads — sandbox breakout. Trips the broad-file-read NO-GO criterion.',
  },
  {
    op: 'file-read-metadata',
    justification:
      'NO-GO: REQUIRED IN BROAD FORM for Homebrew symlink resolution (the closure’s /opt/homebrew/opt/* install names are symlinks). Unfilterable to exact closure paths. Trips the broad file-read-metadata NO-GO criterion.',
  },
  {
    op: 'sysctl-read',
    justification:
      'Node/dyld startup reads sysctls. Broad in the prototype; would need enumeration to exact keys before any trusted use.',
  },
  {
    op: 'mach-lookup',
    justification:
      'Node startup performs Mach lookups. Broad in the prototype; would need narrowing to the failure-discovered minimal exact set before any trusted use.',
  },
  {
    op: 'signal',
    target: 'self',
    justification: 'Node signal handling to its own process. Exact self-target.',
  },
]);

/**
 * sha256 over the canonical JSON of DARWIN_SBPL_ALLOWLIST. Used to detect
 * drift between the audited list and any generated profile. Because the gate
 * is NO-GO this digest identifies a NON-USABLE allowlist.
 */
export const DARWIN_SBPL_ALLOWLIST_DIGEST =
  'sha256:328551371db174d8d7ec5c1f2f272bb83de8fb2efd0bfd4e256cadbc18e7584b';

/**
 * True when every grant in the allowlist is path-exact (no broad op). For the
 * audited T5 list this is false — it is the machine-readable NO-GO signal a
 * future trusted backend must check before consuming the allowlist.
 */
export function darwinAllowlistIsFullyExact(list: readonly DarwinSbplAllowEntry[]): boolean {
  return list.every((e) => e.target !== undefined && !e.justification.startsWith('NO-GO'));
}
