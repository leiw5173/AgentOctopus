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
  const json = JSON.stringify(obj) ?? '';
  let out = json;
  for (const s of secrets) {
    out = out.split(s).join('[REDACTED]');
  }
  return JSON.parse(out) as T;
}
