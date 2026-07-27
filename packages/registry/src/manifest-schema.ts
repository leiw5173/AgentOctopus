import { z } from 'zod';
import { SandboxRequestSchema } from '@agentoctopus/sandbox';

export const AuthSchema = z.enum(['none', 'api_key', 'oauth', 'bearer']);
export const AdapterSchema = z.enum(['http', 'mcp', 'subprocess', 'openai', 'composed']);
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
  input_schema: z.record(z.string(), z.string()).optional(),
  output_schema: z.record(z.string(), z.string()).optional(),
  rating: z.number().min(0).max(5).default(3.0),
  invocations: z.number().int().min(0).default(0),
  enabled: z.boolean().default(true),
  // Rating system: task type determines dimension weights for routing score
  taskType: z.enum(['one-shot', 'long-running', 'agent-collab']).default('one-shot'),
  // Optional overrides for latency/tokenCost normalization targets
  latencyTarget: z.number().positive().optional(),
  tokenCostTarget: z.number().positive().optional(),
  // optional LLM-based skill (no endpoint, uses system LLM)
  llm_powered: z.boolean().default(false),
  credentials: z.array(CredentialSchema).optional(),
  // Sandbox configuration for isolated execution — untrusted requests only,
  // owned by @agentoctopus/sandbox. Trusted config/grants live in octopus.json.
  sandbox: SandboxRequestSchema.optional(),
  // Composition: skill chaining DAG
  compose: z.object({
    steps: z.array(z.object({
      skill: z.string(),
      inputMapping: z.record(z.string(), z.string()).optional(),
      outputAs: z.string().optional(),
      condition: z.string().optional(),
    })),
  }).optional(),
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

export interface RequiredEnvVar {
  key: string;
  label?: string;
}

/**
 * Extract required binary names from a skill manifest.
 * Checks both metadata.openclaw.requires.bins and metadata.clawdbot.requires.bins.
 */
export function getRequiredBins(manifest: SkillManifest): string[] {
  const bins = new Set<string>();

  const openclawBins = (manifest.metadata as any)?.openclaw?.requires?.bins;
  if (Array.isArray(openclawBins)) {
    openclawBins.filter((b): b is string => typeof b === 'string').forEach(b => bins.add(b));
  }

  const clawdbotBins = (manifest.metadata as any)?.clawdbot?.requires?.bins;
  if (Array.isArray(clawdbotBins)) {
    clawdbotBins.filter((b): b is string => typeof b === 'string').forEach(b => bins.add(b));
  }

  return [...bins];
}

/**
 * Extract required env vars from a skill manifest.
 * Checks both `credentials` (our format) and `metadata.openclaw.env` (community format).
 */
export function getRequiredEnvVars(manifest: SkillManifest): RequiredEnvVar[] {
  // From credentials array
  const fromCreds = (manifest.credentials ?? [])
    .filter(c => c.required !== false)
    .map(c => ({ key: c.key, label: c.label }));

  // From metadata.openclaw.env — supports array and object formats
  const envMeta = manifest.metadata?.openclaw?.env;
  let fromMeta: RequiredEnvVar[] = [];
  if (Array.isArray(envMeta)) {
    fromMeta = envMeta.filter((v): v is string => typeof v === 'string').map(key => ({ key }));
  } else if (envMeta && typeof envMeta === 'object') {
    const required = (envMeta as { required?: { name?: string; label?: string }[] }).required ?? [];
    fromMeta = required
      .filter(e => typeof e.name === 'string')
      .map(e => ({ key: e.name!, label: e.label }));
  }

  // Deduplicate by key, preserving label from first occurrence
  const seen = new Map<string, string | undefined>();
  for (const v of [...fromCreds, ...fromMeta]) {
    if (!seen.has(v.key)) seen.set(v.key, v.label);
  }
  return [...seen.entries()].map(([key, label]) => ({ key, label }));
}
