import { z } from 'zod';

export const AuthSchema = z.enum(['none', 'api_key', 'oauth', 'bearer']);
export const AdapterSchema = z.enum(['http', 'mcp', 'subprocess', 'openai']);
export const HostingSchema = z.enum(['cloud', 'local', 'both']);

const CredentialSchema = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'credential key must be a valid env-var name (e.g. XAI_API_KEY)'),
  label: z.string(),
  required: z.boolean().default(true),
});

export const SkillManifestSchema = z.object({
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()).default([]),
  version: z.string().default('1.0.0'),
  endpoint: z.string().optional(),
  adapter: AdapterSchema.default('http'),
  hosting: HostingSchema.default('cloud'),
  auth: AuthSchema.default('none'),
  input_schema: z.record(z.string()).optional(),
  output_schema: z.record(z.string()).optional(),
  rating: z.number().min(0).max(5).default(3.0),
  invocations: z.number().int().min(0).default(0),
  enabled: z.boolean().default(true),
  // optional LLM-based skill (no endpoint, uses system LLM)
  llm_powered: z.boolean().default(false),
  credentials: z.array(CredentialSchema).optional(),
  // OpenClaw-specific metadata — used by the executor's env-var guard
  metadata: z
    .object({
      openclaw: z
        .object({
          /**
           * Environment variables the skill requires at runtime.
           * Accepts both array format (our skills: ["XAI_API_KEY"])
           * and object format (community: { required: [{name:...}], optional: [{name:...}] })
           */
          env: z.union([
            z.array(z.string()),
            z.object({ required: z.array(z.any()).optional(), optional: z.array(z.any()).optional() })
              .passthrough(),
          ]).optional(),
          /** URL shown in the "get your key at …" hint message. */
          homepage: z.string().optional(),
        })
        .passthrough()  // allow extra fields (emoji, primaryEnv, etc.) without rejection
        .optional(),
    })
    .passthrough()
    .optional(),
});

export type SkillManifest = z.infer<typeof SkillManifestSchema>;
export type Adapter = z.infer<typeof AdapterSchema>;
export type Auth = z.infer<typeof AuthSchema>;
export type SkillCredential = z.infer<typeof CredentialSchema>;

/**
 * Extract required env var names from a skill manifest.
 * Checks both `credentials` (our format) and `metadata.openclaw.env` (community format).
 */
export function getRequiredEnvVars(manifest: SkillManifest): string[] {
  // From credentials array
  const fromCreds = (manifest.credentials ?? [])
    .filter(c => c.required !== false)
    .map(c => c.key);

  // From metadata.openclaw.env — supports array and object formats
  const envMeta = manifest.metadata?.openclaw?.env;
  let fromMeta: string[] = [];
  if (Array.isArray(envMeta)) {
    fromMeta = envMeta.filter((v): v is string => typeof v === 'string');
  } else if (envMeta && typeof envMeta === 'object') {
    const required = (envMeta as { required?: { name?: string }[] }).required ?? [];
    fromMeta = required.map(e => e.name).filter((v): v is string => typeof v === 'string');
  }

  return [...new Set([...fromCreds, ...fromMeta])];
}
