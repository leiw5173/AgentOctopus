import dns from 'node:dns/promises';
import net from 'node:net';

export type DnsLookup = (host: string) => Promise<readonly { address: string; family: 4 | 6 }[]>;

const systemLookup: DnsLookup = async (host) =>
  await dns.lookup(host, { all: true, verbatim: true }) as Array<{ address: string; family: 4 | 6 }>;

/**
 * Thrown when a requested host (literal or DNS answer) resolves to a
 * private/link-local/forbidden address. This is a *policy* denial, not an
 * upstream failure, so `forward()` surfaces it as 403 — never 502.
 * `kind` distinguishes a forbidden IP literal from a forbidden DNS answer so
 * tests and logs can tell the two policy paths apart.
 */
export class ForbiddenAddressError extends Error {
  constructor(public readonly host: string, address: string, kind: 'literal' | 'dns') {
    super(
      kind === 'literal'
        ? `forbidden literal address for ${host}: ${address}`
        : `forbidden DNS answer for ${host}: ${address}`,
    );
    this.name = 'ForbiddenAddressError';
  }
}

/** Resolve once, reject forbidden answers, and return the exact address to dial. */
export async function resolveAndPin(host: string, opts: {
  lookup?: DnsLookup;
  isForbiddenAddress: (address: string) => boolean;
  allowPrivateLiteral: boolean;
}): Promise<string> {
  if (net.isIP(host)) {
    if (opts.isForbiddenAddress(host) && !opts.allowPrivateLiteral) {
      throw new ForbiddenAddressError(host, host, 'literal');
    }
    return host;
  }

  const results = await (opts.lookup ?? systemLookup)(host);
  if (results.length === 0) throw new Error(`DNS resolution returned no addresses for ${host}`);
  const forbidden = results.find(r => opts.isForbiddenAddress(r.address));
  if (forbidden) throw new ForbiddenAddressError(host, forbidden.address, 'dns');
  return results[0]!.address;
}
