import { z } from 'zod';
import { SandboxConfigSchema as CanonicalSandboxConfigSchema } from '@agentoctopus/sandbox';

export const LLMConfigSchema = z.object({
  provider: z.enum(['openai', 'gemini', 'ollama', 'anthropic']).default('openai'),
  model: z.string().default('gpt-4o'),
  apiKey: z.string().default(''),
  baseUrl: z.string().default('https://api.openai.com/v1'),
});
export type LLMConfigSection = z.infer<typeof LLMConfigSchema>;

export const EmbedConfigSchema = z.object({
  provider: z.enum(['openai', 'gemini', 'ollama', 'anthropic']).default('openai'),
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
  deviceId: z.string().nullable().default(null),
});
export type RatingConfigSection = z.infer<typeof RatingConfigSchema>;

export const SlackConfigSchema = z.object({
  port: z.number().int().default(3001),
});
export type SlackConfigSection = z.infer<typeof SlackConfigSchema>;

export const SkillPerConfigSchema = z.object({
  enabled: z.boolean().optional(),
  apiKey: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const SkillsConfigSchema = z.object({
  allowBundled: z.array(z.string()).optional(),
  entries: z.record(z.string(), SkillPerConfigSchema).optional(),
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
  installPrefs: z.record(z.string(), z.enum(['always', 'never', 'prompt'])).optional(),
});
export type SkillsConfigSection = z.infer<typeof SkillsConfigSchema>;

export const EvolutionConfigSchema = z.object({
  enabled: z.boolean().default(false),
  autoApplySafe: z.boolean().default(true),
  signalThreshold: z.number().int().min(1).default(10),
  feedbackThreshold: z.number().int().min(1).default(3),
  staleDays: z.number().int().min(1).default(30),
  maxHistorySnapshots: z.number().int().min(1).default(20),
  scheduleCron: z.string().default('0 3 * * *'),
});
export type EvolutionConfigSection = z.infer<typeof EvolutionConfigSchema>;

// ── Agent Config (multi-agent routing) ───────────────────────────────────

export const AgentConfigSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  model: LLMConfigSchema.partial().optional(),
  workspace: z.string().optional(),
  dmPolicy: z.enum(['pairing', 'open']).default('pairing'),
  sandbox: z.object({
    enabled: z.boolean().default(false),
    backend: z.enum(['docker', 'ssh', 'openshell', 'none']).default('none'),
    image: z.string().optional(),
    memory: z.string().optional(),
    timeout: z.number().int().optional(),
  }).optional(),
  skills: SkillsConfigSchema.partial().optional(),
});
export type AgentConfigSection = z.infer<typeof AgentConfigSchema>;

export const AgentsConfigSchema = z.object({
  default: z.string().optional(),
  entries: z.array(AgentConfigSchema).optional(),
});
export type AgentsConfigSection = z.infer<typeof AgentsConfigSchema>;

// ── Sandbox Config (global defaults) ─────────────────────────────────────
//
// The canonical shape is owned by @agentoctopus/sandbox (Plan 1). Core
// re-exports it so callers see one definition; it must NOT be redefined here.
export const SandboxConfigSchema = CanonicalSandboxConfigSchema;
export type SandboxConfigSection = z.infer<typeof SandboxConfigSchema>;

// ── Canvas Config ────────────────────────────────────────────────────────

export const CanvasConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().default(3003),
});
export type CanvasConfigSection = z.infer<typeof CanvasConfigSchema>;

// ── Companion Config ─────────────────────────────────────────────────────

export const CompanionConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().default(3004),
  heartbeatIntervalMs: z.number().int().default(30000),
});
export type CompanionConfigSection = z.infer<typeof CompanionConfigSchema>;

export const OctopusConfigV2Schema = z.object({
  version: z.literal(2),
  credentials: z.record(z.string(), z.string()).optional(),
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
  evolution: EvolutionConfigSchema.partial().default({}),
  agents: AgentsConfigSchema.partial().default({}),
  sandbox: SandboxConfigSchema.partial().default({}),
  canvas: CanvasConfigSchema.partial().default({}),
  companion: CompanionConfigSchema.partial().default({}),
});

export type OctopusConfigV2 = z.input<typeof OctopusConfigV2Schema>;

export interface ResolvedConfig {
  credentials?: Record<string, string>;
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
  evolution: EvolutionConfigSection;
  agents: AgentsConfigSection;
  sandbox: SandboxConfigSection;
  canvas: CanvasConfigSection;
  companion: CompanionConfigSection;
}
