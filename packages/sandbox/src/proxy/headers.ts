import type http from 'node:http';
import type { CredentialGrant } from '../schema.js';

export class SmugglingError extends Error { constructor(m: string) { super(m); this.name = 'SmugglingError'; } }

export const HOP_BY_HOP_HEADERS = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
] as const;

type Headers = Record<string, string | string[]>;

/** Strip hop-by-hop headers and reject request-smuggling ambiguity (spec §9). */
export function sanitizeRequestHeaders(
  headers: http.IncomingHttpHeaders,
  rawHeaders: readonly string[],
): Headers {
  let hostCount = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === 'host') hostCount++;
  }
  if (hostCount !== 1) throw new SmugglingError(hostCount === 0 ? 'missing Host header' : 'duplicate Host header');

  const out: Headers = {};
  const sawContentLength = headers['content-length'] !== undefined;
  const sawTransferEncoding = headers['transfer-encoding'] !== undefined;
  if (sawContentLength && sawTransferEncoding) {
    throw new SmugglingError('conflicting Content-Length and Transfer-Encoding');
  }

  for (const [rawKey, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const key = rawKey.toLowerCase();
    if (key === 'content-length' && Array.isArray(value) && new Set(value).size > 1) {
      throw new SmugglingError('conflicting Content-Length values');
    }
    if ((HOP_BY_HOP_HEADERS as readonly string[]).includes(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Replace upstream framing with one exact length for the fully buffered body. */
export function sanitizeResponseHeaders(
  headers: http.IncomingHttpHeaders,
  bodyLength: number,
): Headers {
  const out: Headers = {};
  for (const [rawKey, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const key = rawKey.toLowerCase();
    if (key === 'content-length' || key === 'transfer-encoding') continue;
    if ((HOP_BY_HOP_HEADERS as readonly string[]).includes(key)) continue;
    out[key] = value;
  }
  out['content-length'] = String(bodyLength);
  return out;
}

/** Overwrite (never append) the managed credential header (spec §9). */
export function injectCredential(headers: Headers, grant: CredentialGrant, secret: string): Headers {
  const out: Headers = { ...headers };
  const target = grant.header.toLowerCase();
  for (const k of Object.keys(out)) {
    if (k.toLowerCase() === target) delete out[k]; // remove any skill-supplied copy
  }
  out[target] = `${grant.prefix ?? ''}${secret}`;
  return out;
}
