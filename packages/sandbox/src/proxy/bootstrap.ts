import type { SecretProvider } from '../secrets.js';
import type { SandboxPolicy } from '../policy.js';
import type { InstallationIdentity } from '../types.js';
import type { ResolvedSecrets } from './egress-proxy.js';

/**
 * Trusted bootstrap (spec §8): resolve ONLY the secrets the effective grants
 * require, for provisioning the proxy sidecar. Never resolves the whole store;
 * never logs values. This host-side path is the ONLY caller of
 * SecretProvider.resolve().
 */
export async function provisionSecrets(
  provider: SecretProvider,
  identity: InstallationIdentity,
  policy: SandboxPolicy,
): Promise<ResolvedSecrets> {
  const out: ResolvedSecrets = {};
  for (const grant of policy.credentials) {
    const value = await provider.resolve(identity, grant.key);
    if (value !== undefined) out[grant.key] = value;
  }
  return out;
}
