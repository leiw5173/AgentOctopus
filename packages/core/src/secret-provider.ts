/**
 * Host-side SecretProvider builder (Plan 5 Task 7 — secret-provider convergence).
 *
 * Credential VALUES live ONLY inside the provider. They are seeded from trusted
 * config (already env-ref-resolved by the config loader) and from credential
 * shaped process.env vars, then handed to the SandboxRunner, whose
 * provisionSecrets() is the SOLE consumer — the values flow to the trusted
 * egress proxy and NOWHERE else (never a prompt, an ExecSpec.env, a log, or an
 * error).
 *
 * Keying follows MapSecretProvider's convention: a bare `${key}` global that any
 * installation identity may resolve. We do NOT seed `${installationId}:${key}`
 * scoped entries here because the installation id is not known at config-load
 * time; the bare-key fallback is the convergence point and matches how the
 * sandbox's own MapSecretProvider resolves (`${id}:${key}` ?? `${key}`).
 *
 * Leaf-compliant: core depends on @agentoctopus/sandbox (core→sandbox is the
 * allowed direction). This module never logs secret material.
 */
import { MapSecretProvider, type SecretProvider } from '@agentoctopus/sandbox';
import type { ResolvedConfig } from './config-types.js';

/**
 * Matches env-var names that look like credentials. Used ONLY to decide which
 * process.env vars are worth seeding into the provider — the names are never
 * surfaced to a prompt; only the (name → value) pair enters the private store.
 */
const CREDENTIAL_KEY_PATTERN = /^[A-Z][A-Z0-9_]*(?:_API_KEY|_KEY|_TOKEN|_SECRET|_APIKEY|_PASSWORD|_CREDENTIALS?)$/;

/**
 * Build a MapSecretProvider seeded from trusted sources. The returned provider
 * owns all credential values; callers must treat it as opaque and pass it to
 * the SandboxRunner unchanged.
 *
 * Trusted sources, in increasing precedence (later wins on key collision):
 *   1. credential-shaped process.env vars (host environment)
 *   2. config.credentials (octopus.json top-level credentials map)
 *   3. config.skills.entries[*].apiKey / .env (per-skill overrides)
 */
export function buildSecretProviderFromConfig(config: ResolvedConfig): SecretProvider {
  const store = new Map<string, string>();

  // 1. Host environment credential values (never logged, never re-read at
  //    execution time — this is the single trusted capture point).
  for (const [key, value] of Object.entries(process.env)) {
    if (value && CREDENTIAL_KEY_PATTERN.test(key)) {
      store.set(key, value);
    }
  }

  // 2. Top-level credentials map (octopus.json `credentials`).
  if (config.credentials) {
    for (const [key, value] of Object.entries(config.credentials)) {
      if (value) store.set(key, value);
    }
  }

  // 3. Per-skill entries: explicit env overrides + apiKey. Explicit `env`
  //    entries are keyed verbatim (the sandbox grant matches by key name).
  //    `apiKey` is a bare VALUE; we key it under the conventional
  //    `<SKILLKEY>_API_KEY` name derived from the entry's config key so a grant
  //    requesting that key resolves it. Values are never logged.
  const entries = config.skills?.entries ?? {};
  for (const [skillKey, entry] of Object.entries(entries)) {
    if (!entry) continue;
    if (entry.env) {
      for (const [key, value] of Object.entries(entry.env)) {
        if (value) store.set(key, value);
      }
    }
    if (entry.apiKey) {
      const conventionalKey = `${skillKey.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
      // Do not clobber an explicitly-named env entry for the same key.
      if (!store.has(conventionalKey)) store.set(conventionalKey, entry.apiKey);
    }
  }

  return new MapSecretProvider(store);
}
