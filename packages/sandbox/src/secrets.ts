import type { InstallationIdentity } from './types.js';

/**
 * SecretProvider (spec §8): only the trusted host bootstrap that provisions the
 * proxy sidecar may call resolve(). Executor/adapters/LLM never see plaintext.
 * Secret values must never enter policy/result/log/error objects.
 */
export interface SecretProvider {
  resolve(identity: InstallationIdentity, key: string): Promise<string | undefined>;
}

/**
 * In-memory provider. Keys are `${installationId}:${key}` with a fallback to a
 * bare `${key}` global. Used by tests and by the host bootstrap. Values are
 * never logged by this class.
 */
export class MapSecretProvider implements SecretProvider {
  constructor(private readonly store: Map<string, string>) {}

  async resolve(identity: InstallationIdentity, key: string): Promise<string | undefined> {
    return this.store.get(`${identity.installationId}:${key}`) ?? this.store.get(key);
  }
}

/**
 * Deep-clone `obj`, replacing any occurrence of a known secret value with
 * '[REDACTED]'. Only keys present in the provider for this identity are
 * considered — but since resolve() needs concrete keys, this helper scans a
 * provided list of candidate keys.
 *
 * Implementation walks the value tree directly (not via JSON round-trip) so
 * secrets containing JSON-escaped characters (quotes, backslashes, control
 * chars) are still matched against raw string leaves.
 */
export async function redactSecrets<T>(
  obj: T,
  provider: SecretProvider,
  identity: InstallationIdentity,
  candidateKeys: string[] = [],
): Promise<T> {
  const secrets: string[] = [];
  for (const k of candidateKeys) {
    const v = await provider.resolve(identity, k);
    if (v) secrets.push(v);
  }
  return walkRedact(obj, secrets) as T;
}

function walkRedact(value: unknown, secrets: string[]): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    let out = value;
    for (const s of secrets) {
      out = out.split(s).join('[REDACTED]');
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map(v => walkRedact(v, secrets));
  }
  if (typeof value === 'object') {
    // Only walk plain objects — leave Date, Map, Set, Buffer, etc. untouched.
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walkRedact(v, secrets);
      }
      return out;
    }
  }
  // number, boolean, bigint, symbol, function, Date, Map, Set, Buffer, etc.
  return value;
}
