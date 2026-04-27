import { z } from 'zod';

export const LLMConfigSchema = z.object({
  provider: z.enum(['openai', 'gemini', 'ollama']).default('openai'),
  model: z.string().default('gpt-4o'),
  apiKey: z.string().default(''),
  baseUrl: z.string().default('https://api.openai.com/v1'),
});
export type LLMConfigSection = z.infer<typeof LLMConfigSchema>;

export const EmbedConfigSchema = z.object({
  provider: z.enum(['openai', 'gemini', 'ollama']).default('openai'),
  model: z.string().default('text-embedding-3-small'),
  apiKey: z.string().default(''),
  baseUrl: z.string().default(''),
});
export type EmbedConfigSection = z.infer<typeof EmbedConfigSchema>;

export const RerankConfigSchema = z.object({
  model: z.string().default('gpt-4o-mini'),
});
export type RerankConfigSection = z.infer<typeof RerankConfigSchema>;

export const GatewayConfigSchema = z.object({
  port: z.number().int().default(3002),
  corsOrigins: z.array(z.string()).default(['*']),
  cloudUrl: z.string().nullable().default(null),
  syncOnStartup: z.boolean().default(true),
});
export type GatewayConfigSection = z.infer<typeof GatewayConfigSchema>;

export const RegistryConfigSchema = z.object({
  skillsDir: z.string().default('./registry/skills'),
  ratingsPath: z.string().default('./registry/ratings.json'),
  noCache: z.boolean().default(false),
});
export type RegistryConfigSection = z.infer<typeof RegistryConfigSchema>;

export const ExecutionConfigSchema = z.object({
  timeoutMs: z.number().int().default(30000),
  maxRetries: z.number().int().default(3),
  timing: z.boolean().default(false),
});
export type ExecutionConfigSection = z.infer<typeof ExecutionConfigSchema>;

export const DeployConfigSchema = z.object({
  mode: z.enum(['local', 'cloud']).default('local'),
  root: z.string().nullable().default(null),
});
export type DeployConfigSection = z.infer<typeof DeployConfigSchema>;

export const AuthConfigSchema = z.object({
  enabled: z.boolean().default(true),
  apiKeysPath: z.string().nullable().default(null),
  rateLimitEnabled: z.boolean().default(true),
});
export type AuthConfigSection = z.infer<typeof AuthConfigSchema>;

export const RatingConfigSchema = z.object({
  feedbackSharing: z.boolean().default(true),
  gistId: z.string().nullable().default(null),
});
export type RatingConfigSection = z.infer<typeof RatingConfigSchema>;

export const SlackConfigSchema = z.object({
  port: z.number().int().default(3001),
});
export type SlackConfigSection = z.infer<typeof SlackConfigSchema>;

export const SkillPerConfigSchema = z.object({
  enabled: z.boolean().optional(),
  apiKey: z.string().optional(),
  env: z.record(z.string()).optional(),
  config: z.record(z.unknown()).optional(),
});

export const SkillsConfigSchema = z.object({
  allowBundled: z.array(z.string()).optional(),
  entries: z.record(SkillPerConfigSchema).optional(),
  load: z.object({
    extraDirs: z.array(z.string()).optional(),
    watch: z.boolean().optional(),
    watchDebounceMs: z.number().int().optional(),
  }).optional(),
  limits: z.object({
    maxSkillsInPrompt: z.number().int().optional(),
    maxSkillsPromptChars: z.number().int().optional(),
    maxSkillFileBytes: z.number().int().optional(),
  }).optional(),
  packs: z.array(z.string()).optional(),
});
export type SkillsConfigSection = z.infer<typeof SkillsConfigSchema>;

export const OctopusConfigV2Schema = z.object({
  version: z.literal(2),
  llm: LLMConfigSchema.partial().default({}),
  embed: EmbedConfigSchema.partial().default({}),
  rerank: RerankConfigSchema.partial().default({}),
  gateway: GatewayConfigSchema.partial().default({}),
  registry: RegistryConfigSchema.partial().default({}),
  execution: ExecutionConfigSchema.partial().default({}),
  deploy: DeployConfigSchema.partial().default({}),
  auth: AuthConfigSchema.partial().default({}),
  rating: RatingConfigSchema.partial().default({}),
  slack: SlackConfigSchema.partial().default({}),
  skills: SkillsConfigSchema.partial().default({}),
});

export type OctopusConfigV2 = z.input<typeof OctopusConfigV2Schema>;

export interface ResolvedConfig {
  llm: LLMConfigSection;
  embed: EmbedConfigSection;
  rerank: RerankConfigSection;
  gateway: GatewayConfigSection;
  registry: RegistryConfigSection;
  execution: ExecutionConfigSection;
  deploy: DeployConfigSection;
  auth: AuthConfigSection;
  rating: RatingConfigSection;
  slack: SlackConfigSection;
  skills: SkillsConfigSection;
}
