# Config Resolver: `octopus.json` as Config Hub — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all ad-hoc `process.env` reads with a typed config resolver that loads `~/.agentoctopus/octopus.json` with `${ENV_VAR}` references resolved from `~/.agentoctopus/.env`.

**Architecture:** New `ConfigResolver` in `packages/core` loads octopus.json, validates with Zod, resolves `${VAR}` → `process.env`, merges defaults, returns a frozen `ResolvedConfig` singleton. All 21+ consumers call `getConfig()` instead of reading `process.env` directly.

**Tech Stack:** TypeScript, Zod (already in registry, added to core), dotenv (already in core)

---

### Task 1: Add Zod to core dependencies

**Files:**
- Modify: `packages/core/package.json`

- [ ] **Step 1: Add zod to dependencies**

```bash
cd packages/core && pnpm add zod
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/package.json packages/core/pnpm-lock.yaml 2>/dev/null || git add packages/core/package.json
git commit -m "chore(core): add zod dependency for config validation

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
"
```

---

### Task 2: Create config-types.ts

**Files:**
- Create: `packages/core/src/config-types.ts`

- [ ] **Step 1: Write config-types.ts**

```typescript
import { z } from 'zod';

// ─── Section Schemas ──────────────────────────────────────────────────────────

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

// ─── Top-level Schema ─────────────────────────────────────────────────────────

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
});

export type OctopusConfigV2 = z.input<typeof OctopusConfigV2Schema>;

// ─── Resolved Config (all defaults applied, all ${VAR} resolved) ──────────────

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
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/config-types.ts
git commit -m "feat(core): add config types and Zod schemas

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
"
```

---

### Task 3: Create config-resolver.ts

**Files:**
- Create: `packages/core/src/config-resolver.ts`

- [ ] **Step 1: Write config-resolver.ts**

```typescript
import fs from 'fs';
import path from 'path';
import os from 'os';
import { OctopusConfigV2Schema, type ResolvedConfig, type OctopusConfigV2 } from './config-types.js';

const CONFIG_DIR = path.join(os.homedir(), '.agentoctopus');
const CONFIG_PATH = path.join(CONFIG_DIR, 'octopus.json');

let _config: ResolvedConfig | null = null;

/**
 * Resolve `${VAR_NAME}` references in a string against process.env.
 * Returns the env value (or empty string if unset) for full-reference strings,
 * or the original string if it's not a reference.
 */
function resolveEnvRef(value: string): string {
  const match = value.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/);
  if (match) {
    return process.env[match[1]] ?? '';
  }
  return value;
}

/** Walk an object deeply and resolve all ${VAR} references in string values. */
function resolveAllEnvRefs<T>(obj: T): T {
  if (typeof obj === 'string') {
    return resolveEnvRef(obj) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveAllEnvRefs) as unknown as T;
  }
  if (obj !== null && typeof obj === 'object') {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      resolved[key] = resolveAllEnvRefs(value);
    }
    return resolved as unknown as T;
  }
  return obj;
}

/**
 * Apply defaults from a Zod schema to a partially-filled object.
 * Only fills fields that are null or undefined.
 */
function applyDefaults<T extends Record<string, unknown>>(
  partial: Partial<T>,
  defaults: T,
): T {
  const result = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    if (partial[key] !== null && partial[key] !== undefined) {
      result[key] = partial[key] as T[keyof T];
    }
  }
  return result;
}

/** Merge a partial section with its Zod schema default. */
function mergeSection<T>(
  sectionSchema: { _def: unknown; parse: (input: unknown) => T },
  partial: Record<string, unknown> | undefined,
): T {
  if (!partial || Object.keys(partial).length === 0) {
    return sectionSchema.parse({});
  }
  return sectionSchema.parse(partial);
}

/**
 * Migrate old v1 octopus.json format to v2 and write back.
 * v1: { skillsDir, ratingsPath, credentials: { KEY: val }, gistId?, feedbackSharing?, maxRetries? }
 */
function migrateV1ToV2(raw: Record<string, unknown>): OctopusConfigV2 {
  const creds = (raw.credentials as Record<string, string>) ?? {};

  const v2: OctopusConfigV2 = {
    version: 2,
    llm: {},
    embed: {},
    rerank: {},
    gateway: {},
    registry: {},
    execution: {},
    deploy: {},
    auth: {},
    rating: {},
    slack: {},
  };

  // Map credentials to llm / embed sections
  if (creds.LLM_PROVIDER) v2.llm!.provider = creds.LLM_PROVIDER as 'openai' | 'gemini' | 'ollama';
  if (creds.LLM_MODEL) v2.llm!.model = creds.LLM_MODEL;
  if (creds.OPENAI_API_KEY) v2.llm!.apiKey = '${OPENAI_API_KEY}';
  if (creds.OPENAI_BASE_URL) v2.llm!.baseUrl = creds.OPENAI_BASE_URL;
  if (creds.EMBED_PROVIDER) v2.embed!.provider = creds.EMBED_PROVIDER as 'openai' | 'gemini' | 'ollama';
  if (creds.EMBED_MODEL) v2.embed!.model = creds.EMBED_MODEL;
  if (creds.EMBED_API_KEY) v2.embed!.apiKey = '${EMBED_API_KEY}';
  if (creds.EMBED_BASE_URL) v2.embed!.baseUrl = creds.EMBED_BASE_URL;

  // Map top-level keys
  if (typeof raw.skillsDir === 'string') v2.registry!.skillsDir = raw.skillsDir;
  if (typeof raw.ratingsPath === 'string') v2.registry!.ratingsPath = raw.ratingsPath;
  if (typeof raw.gistId === 'string') v2.rating!.gistId = raw.gistId;
  if (typeof raw.feedbackSharing === 'boolean') v2.rating!.feedbackSharing = raw.feedbackSharing;
  if (typeof raw.maxRetries === 'number') v2.execution!.maxRetries = raw.maxRetries;

  return v2;
}

/**
 * Load configuration from ~/.agentoctopus/octopus.json.
 *
 * 1. If ~/.agentoctopus/.env exists, load it via dotenv (doesn't override existing env vars)
 * 2. Read octopus.json, migrate from v1 if needed
 * 3. Validate with Zod, resolve ${VAR} references, fill defaults
 * 4. Cache and return frozen ResolvedConfig
 *
 * Subsequent calls return the cached config. Use resetConfig() to clear.
 */
export function loadConfig(): ResolvedConfig {
  if (_config) return _config;

  // Load .env from ~/.agentoctopus/.env (dotenv does NOT override existing vars)
  const envPath = path.join(CONFIG_DIR, '.env');
  if (fs.existsSync(envPath)) {
    // Dynamic import to avoid bundling issues in Next.js
    const dotenv = requireDynamic('dotenv');
    if (dotenv) {
      dotenv.config({ path: envPath, override: false });
    }
  }

  // Parse octopus.json (migrate v1 → v2 if needed)
  let raw: Record<string, unknown> | null = null;
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      console.warn(`[ConfigResolver] Failed to parse ${CONFIG_PATH}, using defaults.`);
    }
  }

  const config: OctopusConfigV2 = raw
    ? raw.version === 2
      ? (raw as OctopusConfigV2)
      : migrateV1ToV2(raw)
    : { version: 2 };

  // Validate and fill defaults
  const parsed = OctopusConfigV2Schema.parse(config) as Record<string, unknown>;

  // Merge each section with its schema defaults
  const llm = mergeSection(LLMConfigSchema, parsed.llm as Record<string, unknown> | undefined);
  const embed = mergeSection(EmbedConfigSchema, parsed.embed as Record<string, unknown> | undefined);
  const rerank = mergeSection(RerankConfigSchema, parsed.rerank as Record<string, unknown> | undefined);
  const gateway = mergeSection(GatewayConfigSchema, parsed.gateway as Record<string, unknown> | undefined);
  const registry = mergeSection(RegistryConfigSchema, parsed.registry as Record<string, unknown> | undefined);
  const execution = mergeSection(ExecutionConfigSchema, parsed.execution as Record<string, unknown> | undefined);
  const deploy = mergeSection(DeployConfigSchema, parsed.deploy as Record<string, unknown> | undefined);
  const auth = mergeSection(AuthConfigSchema, parsed.auth as Record<string, unknown> | undefined);
  const rating = mergeSection(RatingConfigSchema, parsed.rating as Record<string, unknown> | undefined);
  const slack = mergeSection(SlackConfigSchema, parsed.slack as Record<string, unknown> | undefined);

  // Resolve ${VAR} references in all sections
  const resolved: ResolvedConfig = {
    llm: resolveAllEnvRefs(llm),
    embed: resolveAllEnvRefs(embed),
    rerank: resolveAllEnvRefs(rerank),
    gateway: resolveAllEnvRefs(gateway),
    registry: resolveAllEnvRefs(registry),
    execution: resolveAllEnvRefs(execution),
    deploy: resolveAllEnvRefs(deploy),
    auth: resolveAllEnvRefs(auth),
    rating: resolveAllEnvRefs(rating),
    slack: resolveAllEnvRefs(slack),
  };

  // Write back migrated v2 config so user sees the new format
  if (raw && raw.version !== 2) {
    try {
      saveConfigFile({ version: 2, llm: resolved.llm, embed: resolved.embed, rerank: resolved.rerank,
        gateway: resolved.gateway, registry: resolved.registry, execution: resolved.execution,
        deploy: resolved.deploy, auth: resolved.auth, rating: resolved.rating, slack: resolved.slack });
    } catch {
      // Don't fail if we can't write the migrated file
    }
  }

  if (!raw) {
    console.warn('[ConfigResolver] No octopus.json found. Run `octopus onboard` to set up.');
  }

  _config = Object.freeze(resolved) as ResolvedConfig;
  return _config;
}

/** Get the already-loaded config. Throws if not loaded yet. */
export function getConfig(): ResolvedConfig {
  if (!_config) {
    throw new Error('Config not loaded. Call loadConfig() first.');
  }
  return _config;
}

/** Reset cached config (for tests). */
export function resetConfig(): void {
  _config = null;
}

/** Get the config directory path. */
export function getConfigDir(): string {
  return CONFIG_DIR;
}

/** Get the octopus.json path. */
export function getConfigPath(): string {
  return CONFIG_PATH;
}

/** Get the ~/.agentoctopus/.env path. */
export function getEnvPath(): string {
  return path.join(CONFIG_DIR, '.env');
}

/** Save config to octopus.json */
export function saveConfigFile(config: OctopusConfigV2): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

/** Write the .env file */
export function saveEnvFile(content: string): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(getEnvPath(), content, 'utf8');
}

/** Dynamic require for optional modules */
function requireDynamic(mod: string): { config: (opts: { path: string; override?: boolean }) => void } | null {
  try {
    // Use createRequire for ESM compatibility
    const { createRequire } = await_import_meta();
    const require = createRequire(import.meta.url);
    return require(mod) as { config: (opts: { path: string; override?: boolean }) => void };
  } catch {
    return null;
  }
}

function await_import_meta(): { createRequire: (url: string) => NodeRequire } {
  return { createRequire: (await import('module')).createRequire } as { createRequire: (url: string) => NodeRequire };
}
```

Wait — that `requireDynamic` is awkward for ESM. Let me use a simpler approach: just import dotenv at the top level since it's already a dependency.

Here's the corrected version:

```typescript
import fs from 'fs';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';
import { OctopusConfigV2Schema, LLMConfigSchema, EmbedConfigSchema, RerankConfigSchema,
  GatewayConfigSchema, RegistryConfigSchema, ExecutionConfigSchema, DeployConfigSchema,
  AuthConfigSchema, RatingConfigSchema, SlackConfigSchema,
  type ResolvedConfig, type OctopusConfigV2 } from './config-types.js';

const CONFIG_DIR = path.join(os.homedir(), '.agentoctopus');
const CONFIG_PATH = path.join(CONFIG_DIR, 'octopus.json');

let _config: ResolvedConfig | null = null;

/** Resolve a single `${VAR_NAME}` reference against process.env. */
function resolveEnvRef(value: string): string {
  const match = value.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/);
  if (match) {
    return process.env[match[1]] ?? '';
  }
  return value;
}

/** Deep-walk an object and resolve all `${VAR}` refs in string values. */
function resolveAllEnvRefs<T>(obj: T): T {
  if (typeof obj === 'string') {
    return resolveEnvRef(obj) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveAllEnvRefs) as unknown as T;
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = resolveAllEnvRefs(value);
    }
    return result as unknown as T;
  }
  return obj;
}

/** Merge a partial section with its Zod schema defaults. Passes empty obj to get full defaults. */
function mergeSection<T>(schema: { parse: (input: unknown) => T }, partial: Record<string, unknown> | undefined): T {
  const input = partial && Object.keys(partial).length > 0 ? partial : {};
  return schema.parse(input);
}

/**
 * Migrate v1 octopus.json → v2.
 * v1 shape: { skillsDir?, ratingsPath?, credentials: Record<string,string>, gistId?, feedbackSharing?, maxRetries? }
 */
function migrateV1ToV2(raw: Record<string, unknown>): OctopusConfigV2 {
  const creds = (raw.credentials as Record<string, string>) ?? {};

  const v2: OctopusConfigV2 = { version: 2 };

  if (creds.LLM_PROVIDER) v2.llm = { ...v2.llm, provider: creds.LLM_PROVIDER as 'openai' | 'gemini' | 'ollama' };
  if (creds.LLM_MODEL) v2.llm = { ...v2.llm, model: creds.LLM_MODEL };
  if (creds.OPENAI_API_KEY) v2.llm = { ...v2.llm, apiKey: '${OPENAI_API_KEY}' };
  if (creds.OPENAI_BASE_URL) v2.llm = { ...v2.llm, baseUrl: creds.OPENAI_BASE_URL };
  if (creds.GEMINI_API_KEY && !creds.OPENAI_API_KEY) v2.llm = { ...v2.llm, apiKey: '${GEMINI_API_KEY}' };
  if (creds.EMBED_PROVIDER) v2.embed = { ...v2.embed, provider: creds.EMBED_PROVIDER as 'openai' | 'gemini' | 'ollama' };
  if (creds.EMBED_MODEL) v2.embed = { ...v2.embed, model: creds.EMBED_MODEL };
  if (creds.EMBED_API_KEY) v2.embed = { ...v2.embed, apiKey: '${EMBED_API_KEY}' };
  if (creds.EMBED_BASE_URL) v2.embed = { ...v2.embed, baseUrl: creds.EMBED_BASE_URL };

  if (typeof raw.skillsDir === 'string') v2.registry = { ...v2.registry, skillsDir: raw.skillsDir };
  if (typeof raw.ratingsPath === 'string') v2.registry = { ...v2.registry, ratingsPath: raw.ratingsPath };
  if (typeof raw.gistId === 'string') v2.rating = { ...v2.rating, gistId: raw.gistId };
  if (typeof raw.feedbackSharing === 'boolean') v2.rating = { ...v2.rating, feedbackSharing: raw.feedbackSharing };
  if (typeof raw.maxRetries === 'number') v2.execution = { ...v2.execution, maxRetries: raw.maxRetries };

  return v2;
}

/**
 * Load configuration from ~/.agentoctopus/octopus.json and ~/.agentoctopus/.env.
 *
 * - Loads .env first (dotenv does NOT override existing process.env values)
 * - Reads octopus.json, auto-migrates v1 → v2
 * - Validates with Zod, applies defaults, resolves ${VAR} references
 * - Returns frozen singleton; subsequent calls are cached
 */
export function loadConfig(): ResolvedConfig {
  if (_config) return _config;

  // 1. Load .env from ~/.agentoctopus/.env
  const envPath = path.join(CONFIG_DIR, '.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }

  // 2. Parse octopus.json
  let raw: Record<string, unknown> | null = null;
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      console.warn(`[ConfigResolver] Failed to parse ${CONFIG_PATH}, using defaults.`);
    }
  }

  // 3. Migrate if needed
  let config: Record<string, unknown>;
  if (!raw) {
    config = { version: 2 };
    console.warn('[ConfigResolver] No octopus.json found. Run `octopus onboard` to set up.');
  } else if (raw.version === 2) {
    config = raw;
  } else {
    config = migrateV1ToV2(raw) as unknown as Record<string, unknown>;
  }

  // 4. Validate & fill defaults per section
  const parsed = OctopusConfigV2Schema.parse(config) as Record<string, Record<string, unknown> | undefined>;

  const resolved: ResolvedConfig = {
    llm: resolveAllEnvRefs(mergeSection(LLMConfigSchema, parsed.llm)),
    embed: resolveAllEnvRefs(mergeSection(EmbedConfigSchema, parsed.embed)),
    rerank: resolveAllEnvRefs(mergeSection(RerankConfigSchema, parsed.rerank)),
    gateway: resolveAllEnvRefs(mergeSection(GatewayConfigSchema, parsed.gateway)),
    registry: resolveAllEnvRefs(mergeSection(RegistryConfigSchema, parsed.registry)),
    execution: resolveAllEnvRefs(mergeSection(ExecutionConfigSchema, parsed.execution)),
    deploy: resolveAllEnvRefs(mergeSection(DeployConfigSchema, parsed.deploy)),
    auth: resolveAllEnvRefs(mergeSection(AuthConfigSchema, parsed.auth)),
    rating: resolveAllEnvRefs(mergeSection(RatingConfigSchema, parsed.rating)),
    slack: resolveAllEnvRefs(mergeSection(SlackConfigSchema, parsed.slack)),
  };

  // 5. Write back migrated config
  if (raw && raw.version !== 2) {
    try {
      saveConfigFile({ version: 2, ...resolved });
    } catch {
      // Non-fatal
    }
  }

  _config = Object.freeze(resolved) as ResolvedConfig;
  return _config;
}

/** Get the already-loaded config. Throws if loadConfig() hasn't been called. */
export function getConfig(): ResolvedConfig {
  if (!_config) {
    throw new Error('Config not loaded. Call loadConfig() first.');
  }
  return _config;
}

/** Reset the cached config (for tests). */
export function resetConfig(): void {
  _config = null;
}

/** Return the config directory path. */
export function getConfigDir(): string {
  return CONFIG_DIR;
}

/** Return the octopus.json path. */
export function getConfigPath(): string {
  return CONFIG_PATH;
}

/** Return the .env path. */
export function getEnvPath(): string {
  return path.join(CONFIG_DIR, '.env');
}

/** Write the v2 config to octopus.json. */
export function saveConfigFile(config: OctopusConfigV2): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

/** Write content to ~/.agentoctopus/.env. */
export function saveEnvFile(content: string): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(getEnvPath(), content, 'utf8');
}
```

Wait, there's an issue with the migration function writing back `${OPENAI_API_KEY}` as the apiKey value. But the migration happens BEFORE the env refs are resolved. And the old credentials map had the actual key value, not the env var reference. Let me think about this...

When migrating from v1:
- The old `credentials` map had actual API key values (e.g., `OPENAI_API_KEY: "sk-abc123"`)
- These were merged into `process.env` at startup
- For v2, we want the config to reference `${OPENAI_API_KEY}` (the env var name)
- BUT we also need the actual key to end up in `~/.agentoctopus/.env`

So the migration should:
1. Take the old credential values and write them to `~/.agentoctopus/.env`
2. Write the v2 config with `${VAR}` references

Let me fix the migration to handle this properly...

Actually, the migration code I wrote in the plan maps `creds.OPENAI_API_KEY` → `apiKey: '${OPENAI_API_KEY}'`. This assumes the actual key is already in an env var called `OPENAI_API_KEY`. But if the user was using the old octopus.json credentials map (set via `octopus config set`), the actual key was stored directly in octopus.json, not in an env var.

For the migration, the simplest approach is: when migrating, take the actual values from the old credentials map and write them to `~/.agentoctopus/.env`, then reference them as `${VAR}` in the v2 config.

But this adds complexity. Let me simplify: the migration just maps the credential keys to v2 structure using env var references. If the user had stored credentials directly in octopus.json, they'll need to set up their `~/.agentoctopus/.env` with the actual keys. The CLI already supports `octopus config set KEY VALUE` which writes to octopus.json, and the onboarding wizard prompts for keys.

Actually, I realize I'm overthinking this. Let me look at how the current system works:
1. User runs `octopus onboard` → writes .env in project root
2. User runs `octopus connect openclaw` → reads LLM config, writes credentials to octopus.json
3. On startup, octopus.json credentials are merged into process.env (overriding .env values)

In the NEW system:
1. User runs `octopus onboard` → writes `~/.agentoctopus/.env` (for actual keys) + `~/.agentoctopus/octopus.json` (with ${VAR} refs)
2. On startup, resolver loads .env, then resolves ${VAR} refs from octopus.json

For the migration (v1 → v2), the key challenge is: old octopus.json credentials had actual API keys embedded. We need to extract them into .env and reference them.

Let me fix the migration to handle this more thoroughly. The migration should:
1. Look at old credentials map
2. For each credential key that looks like an env var name (e.g., OPENAI_API_KEY, LLM_PROVIDER), preserve the key name
3. Write the values to `~/.agentoctopus/.env`
4. Write v2 config with `${KEY_NAME}` references

OK, the plan is getting quite long. Let me finish writing it with this correction. I'll make the migration more robust in the plan.

Actually, the plan is already very long and the migration is an edge case. Let me keep the migration simple: it maps old credential keys to env var references, and writes the actual values to .env. Let me keep writing the plan.

Actually, wait. Let me re-think this. The plan document should be clear and complete. Let me fix the migration code in the plan, then move on to the consumer updates.<｜end▁of▁thinking｜>

<｜DSML｜tool_calls>
<｜DSML｜invoke name="Write">
<｜DSML｜parameter name="content" string="true"># Config Resolver: `octopus.json` as Config Hub — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all ad-hoc `process.env` reads with a typed config resolver that loads `~/.agentoctopus/octopus.json` with `${ENV_VAR}` references resolved from `~/.agentoctopus/.env`.

**Architecture:** New `ConfigResolver` in `packages/core` loads `octopus.json`, validates with Zod, resolves `${VAR}` → `process.env`, merges defaults, returns a frozen `ResolvedConfig` singleton. All consumers call `getConfig()` instead of reading `process.env` directly.

**Tech Stack:** TypeScript, Zod (added to core), dotenv (already in core)

---

### Task 1: Add Zod to core dependencies

**Files:**
- Modify: `packages/core/package.json`

- [ ] **Step 1: Install zod**

```bash
cd packages/core && pnpm add zod
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/package.json
git commit -m "chore(core): add zod dependency for config validation

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
"
```

---

### Task 2: Create config-types.ts

**Files:**
- Create: `packages/core/src/config-types.ts`

- [ ] **Step 1: Write the types file**

```typescript
import { z } from 'zod';

// ─── Section schemas ──────────────────────────────────────────────────────────

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

// ─── Top-level schema ─────────────────────────────────────────────────────────

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
});

export type OctopusConfigV2 = z.input<typeof OctopusConfigV2Schema>;

// ─── Resolved config (all defaults + ${VAR} resolved) ─────────────────────────

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
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/config-types.ts
git commit -m "feat(core): add config types and Zod schemas for v2 config

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
"
```

---

### Task 3: Create config-resolver.ts

**Files:**
- Create: `packages/core/src/config-resolver.ts`

- [ ] **Step 1: Write the resolver**

```typescript
import fs from 'fs';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';
import {
  OctopusConfigV2Schema, LLMConfigSchema, EmbedConfigSchema,
  RerankConfigSchema, GatewayConfigSchema, RegistryConfigSchema,
  ExecutionConfigSchema, DeployConfigSchema, AuthConfigSchema,
  RatingConfigSchema, SlackConfigSchema,
  type ResolvedConfig, type OctopusConfigV2,
} from './config-types.js';

const CONFIG_DIR = path.join(os.homedir(), '.agentoctopus');
const CONFIG_PATH = path.join(CONFIG_DIR, 'octopus.json');

let _config: ResolvedConfig | null = null;

/** Resolve a single `${VAR}` reference. Returns env value or empty string. */
function resolveEnvRef(value: string): string {
  const m = value.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/);
  return m ? (process.env[m[1]] ?? '') : value;
}

/** Deep-walk an object resolving all `${VAR}` refs in string leaves. */
function resolveAllEnvRefs<T>(obj: T): T {
  if (typeof obj === 'string') return resolveEnvRef(obj) as unknown as T;
  if (Array.isArray(obj)) return obj.map(resolveAllEnvRefs) as unknown as T;
  if (obj !== null && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = resolveAllEnvRefs(v);
    }
    return out as unknown as T;
  }
  return obj;
}

/** Merge partial section with its schema's defaults. */
function mergeSection<T>(schema: { parse(i: unknown): T }, partial: Record<string, unknown> | undefined): T {
  return schema.parse(partial && Object.keys(partial).length > 0 ? partial : {});
}

/** Migrate v1 octopus.json → v2. Writes old credential values to .env, uses ${KEY} refs. */
function migrateV1ToV2(raw: Record<string, unknown>): OctopusConfigV2 {
  const creds = (raw.credentials as Record<string, string>) ?? {};

  // Collect env vars to write
  const envLines: string[] = ['# AgentOctopus — migrated from octopus.json v1'];

  const v2: OctopusConfigV2 = { version: 2 };

  if (creds.LLM_PROVIDER) v2.llm = { ...v2.llm, provider: creds.LLM_PROVIDER as OctopusConfigV2['llm']['provider'] };
  if (creds.LLM_MODEL) v2.llm = { ...v2.llm, model: creds.LLM_MODEL };
  if (creds.OPENAI_API_KEY) { v2.llm = { ...v2.llm, apiKey: '${OPENAI_API_KEY}' }; envLines.push(`OPENAI_API_KEY=${creds.OPENAI_API_KEY}`); }
  if (creds.OPENAI_BASE_URL) v2.llm = { ...v2.llm, baseUrl: creds.OPENAI_BASE_URL };
  if (creds.GEMINI_API_KEY) { envLines.push(`GEMINI_API_KEY=${creds.GEMINI_API_KEY}`); }
  if (creds.EMBED_PROVIDER) v2.embed = { ...v2.embed, provider: creds.EMBED_PROVIDER as OctopusConfigV2['embed']['provider'] };
  if (creds.EMBED_MODEL) v2.embed = { ...v2.embed, model: creds.EMBED_MODEL };
  if (creds.EMBED_API_KEY) { v2.embed = { ...v2.embed, apiKey: '${EMBED_API_KEY}' }; envLines.push(`EMBED_API_KEY=${creds.EMBED_API_KEY}`); }
  if (creds.EMBED_BASE_URL) v2.embed = { ...v2.embed, baseUrl: creds.EMBED_BASE_URL };

  if (typeof raw.skillsDir === 'string') v2.registry = { ...v2.registry, skillsDir: raw.skillsDir };
  if (typeof raw.ratingsPath === 'string') v2.registry = { ...v2.registry, ratingsPath: raw.ratingsPath };
  if (typeof raw.gistId === 'string') v2.rating = { ...v2.rating, gistId: raw.gistId };
  if (typeof raw.feedbackSharing === 'boolean') v2.rating = { ...v2.rating, feedbackSharing: raw.feedbackSharing };
  if (typeof raw.maxRetries === 'number') v2.execution = { ...v2.execution, maxRetries: raw.maxRetries };

  // Write extracted secrets to .env
  if (envLines.length > 1) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(path.join(CONFIG_DIR, '.env'), envLines.join('\n') + '\n', 'utf8');
  }

  return v2;
}

/** Load config, load .env, resolve refs, cache. */
export function loadConfig(): ResolvedConfig {
  if (_config) return _config;

  // 1. Load ~/.agentoctopus/.env (doesn't override existing env vars)
  const envPath = path.join(CONFIG_DIR, '.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }

  // 2. Parse octopus.json
  let raw: Record<string, unknown> | null = null;
  if (fs.existsSync(CONFIG_PATH)) {
    try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {
      console.warn(`[ConfigResolver] Failed to parse ${CONFIG_PATH}, using defaults.`);
    }
  }

  // 3. Migrate v1 → v2 if needed
  let configObj: Record<string, unknown>;
  if (!raw) {
    configObj = { version: 2 };
    console.warn('[ConfigResolver] No octopus.json found. Run `octopus onboard` to configure.');
  } else if (raw.version === 2) {
    configObj = raw;
  } else {
    configObj = migrateV1ToV2(raw) as unknown as Record<string, unknown>;
  }

  // 4. Validate with Zod
  const parsed = OctopusConfigV2Schema.parse(configObj) as Record<string, Record<string, unknown> | undefined>;

  // 5. Merge defaults + resolve ${VAR} refs
  const resolved: ResolvedConfig = {
    llm: resolveAllEnvRefs(mergeSection(LLMConfigSchema, parsed.llm)),
    embed: resolveAllEnvRefs(mergeSection(EmbedConfigSchema, parsed.embed)),
    rerank: resolveAllEnvRefs(mergeSection(RerankConfigSchema, parsed.rerank)),
    gateway: resolveAllEnvRefs(mergeSection(GatewayConfigSchema, parsed.gateway)),
    registry: resolveAllEnvRefs(mergeSection(RegistryConfigSchema, parsed.registry)),
    execution: resolveAllEnvRefs(mergeSection(ExecutionConfigSchema, parsed.execution)),
    deploy: resolveAllEnvRefs(mergeSection(DeployConfigSchema, parsed.deploy)),
    auth: resolveAllEnvRefs(mergeSection(AuthConfigSchema, parsed.auth)),
    rating: resolveAllEnvRefs(mergeSection(RatingConfigSchema, parsed.rating)),
    slack: resolveAllEnvRefs(mergeSection(SlackConfigSchema, parsed.slack)),
  };

  // 6. Write back migrated config
  if (raw && raw.version !== 2) {
    try { saveConfigFile({ version: 2, ...resolved }); } catch { /* non-fatal */ }
  }

  _config = Object.freeze(resolved) as ResolvedConfig;
  return _config;
}

/** Get cached config. Throws if loadConfig() not yet called. */
export function getConfig(): ResolvedConfig {
  if (!_config) throw new Error('Config not loaded. Call loadConfig() first.');
  return _config;
}

/** Reset cache (for tests). */
export function resetConfig(): void {
  _config = null;
}

export function getConfigDir(): string { return CONFIG_DIR; }
export function getConfigPath(): string { return CONFIG_PATH; }
export function getEnvPath(): string { return path.join(CONFIG_DIR, '.env'); }

export function saveConfigFile(config: OctopusConfigV2): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

export function saveEnvFile(content: string): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(getEnvPath(), content, 'utf8');
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/config-resolver.ts
git commit -m "feat(core): add ConfigResolver for octopus.json with \${VAR} resolution

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
"
```

---

### Task 4: Export from core/index.ts

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add exports**

In `packages/core/src/index.ts`, add at the bottom after line 5:

```typescript
export {
  loadConfig, getConfig, resetConfig,
  getConfigDir, getConfigPath, getEnvPath,
  saveConfigFile, saveEnvFile,
} from './config-resolver.js';
export type { ResolvedConfig, OctopusConfigV2 } from './config-types.js';
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): export config resolver and types

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
"
```

---

### Task 5: Update gateway/engine.ts

**Files:**
- Modify: `packages/gateway/src/engine.ts`

- [ ] **Step 1: Replace process.env reads with getConfig()**

Replace lines 1-84 of `packages/gateway/src/engine.ts`:

```typescript
import path from 'path';
import os from 'os';
import { SkillRegistry, syncFromCloud } from '@agentoctopus/registry';
import { Router, Executor, createChatClient, type ChatClient, type LLMConfig, getConfig, loadConfig } from '@agentoctopus/core';

export const DIRECT_ANSWER_SYSTEM_PROMPT = 'You are a helpful assistant. Answer the user\'s question concisely and accurately.';

const DEFAULT_HOME = path.join(os.homedir(), '.agentoctopus');

export interface OctopusEngine {
  registry: SkillRegistry;
  router: Router;
  executor: Executor;
  chatClient: ChatClient;
}

let _engine: OctopusEngine | null = null;

export async function bootstrapEngine(rootDir?: string): Promise<OctopusEngine> {
  if (_engine) return _engine;

  const config = loadConfig();

  const skillsDir = path.join(DEFAULT_HOME, 'skills');
  const ratingsPath = path.join(DEFAULT_HOME, 'ratings.json');

  // Sync skills from cloud before loading registry (local mode)
  if (config.gateway.cloudUrl && config.gateway.syncOnStartup) {
    try {
      const result = await syncFromCloud(config.gateway.cloudUrl, skillsDir);
      const total = result.added.length + result.updated.length;
      if (total > 0) {
        console.log(`[Engine] Synced ${total} skill(s) from ${config.gateway.cloudUrl} (added: ${result.added.length}, updated: ${result.updated.length})`);
      }
    } catch (err) {
      console.warn(`[Engine] Startup sync from ${config.gateway.cloudUrl} failed: ${(err as Error).message}`);
    }
  }

  const registry = new SkillRegistry(skillsDir, ratingsPath);
  await registry.load();

  const chatConfig: LLMConfig = {
    provider: config.llm.provider,
    model: config.llm.model,
    apiKey: config.llm.apiKey || undefined,
    baseUrl: config.llm.baseUrl,
  };

  const rerankConfig: LLMConfig = {
    ...chatConfig,
    model: config.rerank.model,
  };

  const embedConfig: LLMConfig | undefined =
    config.embed.apiKey
      ? {
          provider: config.embed.provider,
          model: config.embed.model,
          apiKey: config.embed.apiKey,
          baseUrl: config.embed.baseUrl || chatConfig.baseUrl,
        }
      : undefined;

  const router = new Router(rerankConfig, embedConfig);
  await router.buildIndex(registry.getAll());

  const chatClient = createChatClient(rerankConfig);
  const executor = new Executor(registry, chatClient);

  _engine = { registry, router, executor, chatClient };
  return _engine;
}

export function resetEngine(): void {
  _engine = null;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/gateway/src/engine.ts
git commit -m "refactor(gateway): use config resolver in engine bootstrap

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
"
```

---

### Task 6: Update gateway/deploy-mode.ts

**Files:**
- Modify: `packages/gateway/src/deploy-mode.ts`

- [ ] **Step 1: Replace process.env with getConfig()**

```typescript
import { getConfig } from '@agentoctopus/core';

export type DeployMode = 'cloud' | 'local';

export function getDeployMode(): DeployMode {
  return getConfig().deploy.mode;
}

export function isCloudMode(): boolean {
  return getDeployMode() === 'cloud';
}

export function isLocalMode(): boolean {
  return getDeployMode() === 'local';
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/gateway/src/deploy-mode.ts
git commit -m "refactor(gateway): use config resolver in deploy-mode

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
"
```

---

### Task 7: Update gateway/agent-protocol.ts

**Files:**
- Modify: `packages/gateway/src/agent-protocol.ts`

- [ ] **Step 1: Update env reads at lines 50, 78, 395, 403, 435-436**

In `createAgentRouter()`, replace lines 49-51 (CORS):
```typescript
    const config = getConfig();
    const allowedOrigins = config.gateway.corsOrigins;
```

Replace line 395 (`/sync` endpoint):
```typescript
    const url = cloudUrl ?? getConfig().gateway.cloudUrl;
```

Replace line 403 (`/sync` endpoint):
```typescript
      const skillsDir = getConfig().registry.skillsDir;
      const result = await syncFromCloud(url, skillsDir, force);
```

Replace lines 76-84 (`/health` and route setup — auth guard):
```typescript
  // Ensure auth middleware path is loaded
```

Replace lines 435-436 (startAgentGateway):
```typescript
    const config = getConfig();
    const authStatus = config.auth.enabled ? '🔒 auth ON' : '🔓 auth OFF';
    const rateStatus = config.auth.rateLimitEnabled ? '⏱ rate-limit ON' : '⏱ rate-limit OFF';
```

Add import at top of file:
```typescript
import { getConfig } from '@agentoctopus/core';
```

- [ ] **Step 2: Commit**

```bash
git add packages/gateway/src/agent-protocol.ts
git commit -m "refactor(gateway): use config resolver in agent-protocol

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
"
```

---

### Task 8: Update gateway/auth-middleware.ts

**Files:**
- Modify: `packages/gateway/src/auth-middleware.ts`

- [ ] **Step 1: Replace env reads at lines 46-47, 208**

Replace `getStorePath()` function (lines 46-47):
```typescript
function getStorePath(): string {
  if (_storePath) return _storePath;
  const config = getConfig();
  const root = config.deploy.root ?? process.cwd();
  _storePath = config.auth.apiKeysPath ?? path.join(root, 'api-keys.json');
  return _storePath;
}
```

Add import at top:
```typescript
import { getConfig } from '@agentoctopus/core';
```

Replace the auth skip check at line 208:
Find `process.env.AUTH_ENABLED !== 'false'` → replace with `getConfig().auth.enabled`:
```typescript
  // Skip auth for public paths
  if (PUBLIC_PATHS.has(req.path)) {
    next();
    return;
  }

  if (!getConfig().auth.enabled) {
    next();
    return;
  }
```

- [ ] **Step 2: Commit**

```bash
git add packages/gateway/src/auth-middleware.ts
git commit -m "refactor(gateway): use config resolver in auth-middleware

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
"
```

---

### Task 9: Update gateway/rate-limiter.ts

**Files:**
- Modify: `packages/gateway/src/rate-limiter.ts`

- [ ] **Step 1: Replace rate limit check**

In the `rateLimiter` function, replace (current line 81):
```typescript
  if (process.env.RATE_LIMIT_ENABLED === 'false') {
```
with:
```typescript
  if (!getConfig().auth.rateLimitEnabled) {
```

Add import at top:
```typescript
import { getConfig } from '@agentoctopus/core';
```

- [ ] **Step 2: Commit**

```bash
git add packages/gateway/src/rate-limiter.ts
git commit -m "refactor(gateway): use config resolver in rate-limiter

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
"
```

---

### Task 10: Update gateway/audit-logger.ts

**Files:**
- Modify: `packages/gateway/src/audit-logger.ts`

- [ ] **Step 1: Replace env reads at lines 28-29, 113**

Replace `getLogDir()`:
```typescript
function getLogDir(): string {
  if (_logDir) return _logDir;
  const config = getConfig();
  const root = config.deploy.root ?? process.cwd();
  _logDir = path.join(root, 'logs');
  return _logDir;
}
```

Replace line 113 `process.env.NODE_ENV !== 'production'` → leave this one as-is, since `NODE_ENV` is a standard Node.js env var, not an AgentOctopus config setting.

Add import at top:
```typescript
import { getConfig } from '@agentoctopus/core';
```

- [ ] **Step 2: Commit**

```bash
git add packages/gateway/src/audit-logger.ts
git commit -m "refactor(gateway): use config resolver in audit-logger

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
"
```

---

### Task 11: Update gateway/slack.ts

**Files:**
- Modify: `packages/gateway/src/slack.ts`

- [ ] **Step 1: Replace port env read**

Replace line 121:
```typescript
  const port = Number(process.env.SLACK_PORT ?? 3001);
```
with:
```typescript
  const port = getConfig().slack.port;
```

Add import at top:
```typescript
import { getConfig } from '@agentoctopus/core';
```

- [ ] **Step 2: Commit**

```bash
git add packages/gateway/src/slack.ts
git commit -m "refactor(gateway): use config resolver in slack

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
"
```

---

### Task 12: Update core/executor.ts

**Files:**
- Modify: `packages/core/src/executor.ts:11,277-278,398-399`

- [ ] **Step 1: Replace timeout at line 11, and usages at 277-278, 398-399**

Add import:
```typescript
import { getConfig } from './config-resolver.js';
```

Delete line 11:
```typescript
// DELETE: const SKILL_EXEC_TIMEOUT_MS = parseInt(process.env.SKILL_EXEC_TIMEOUT_MS ?? '30000', 10);
```

Replace lines 277-278:
```typescript
      }, getConfig().execution.timeoutMs);
```
(line 277 uses `SKILL_EXEC_TIMEOUT_MS` in the error message — keep as string interpolation using `getConfig().execution.timeoutMs`)

Replace line 278 timeout:
```typescript
      }, getConfig().execution.timeoutMs);
```

Replace lines 398-399 similarly:
```typescript
      }, getConfig().execution.timeoutMs);
```
(the two usages are in the `invokeSubprocess()` and `invokeHttp()` methods)

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/executor.ts
git commit -m "refactor(core): use config resolver for execution timeout

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
"
```

---

### Task 13: Update core/router.ts

**Files:**
- Modify: `packages/core/src/router.ts`

- [ ] **Step 1: No env reads to replace**

The router's `penalizeUnconfiguredSkills()` method (line 457) checks `process.env[v.key]` for skill-declared credential keys. This is correct — those are dynamic per-skill credentials passed via env vars, not static config. Keep this as-is.

No changes needed for router.ts.

---

### Task 14: Update adapters/subprocess-adapter.ts

**Files:**
- Modify: `packages/adapters/src/subprocess-adapter.ts:91,132-133`

- [ ] **Step 1: Replace timeout at line 91, usages at 132-133**

Add import at top:
```typescript
import { getConfig } from '@agentoctopus/core';
```

Delete line 91:
```typescript
// DELETE: const SKILL_EXEC_TIMEOUT_MS = parseInt(process.env.SKILL_EXEC_TIMEOUT_MS ?? '30000', 10);
```

Replace lines 132-133:
```typescript
      resolve({ success: false, error: `Skill timed out after ${getConfig().execution.timeoutMs}ms` });
    }, getConfig().execution.timeoutMs);
```

- [ ] **Step 2: Commit**

```bash
git add packages/adapters/src/subprocess-adapter.ts
git commit -m "refactor(adapters): use config resolver for execution timeout

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
"
```

---

### Task 15: Update adapters/http-adapter.ts

**Files:**
- Modify: `packages/adapters/src/http-adapter.ts`

- [ ] **Step 1: Keep env read for SKILL_*_API_KEY as-is**

The `SKILL_<NAME>_API_KEY` pattern at line 19 is a dynamic per-skill credential check. This is not static config — it's a convention-based env var lookup. Keep it as-is.

No changes needed for http-adapter.ts.

---

### Task 16: Update adapters/mcp-adapter.ts

**Files:**
- Modify: `packages/adapters/src/mcp-adapter.ts`

- [ ] **Step 1: No changes needed**

The MCP adapter passes `process.env` wholesale to MCP child processes (line 54). This is correct behavior — MCP servers may need any env var. Keep as-is.

No changes needed for mcp-adapter.ts.

---

### Task 17: Update registry/registry.ts

**Files:**
- Modify: `packages/registry/src/registry.ts`

- [ ] **Step 1: Replace OCTOPUS_NO_CACHE env read**

Replace line 175:
```typescript
    if (!process.env.OCTOPUS_NO_CACHE) {
```
with:
```typescript
    const { getConfig } = await import('@agentoctopus/core');
    if (!getConfig().registry.noCache) {
```

But wait — `@agentoctopus/registry` doesn't depend on `@agentoctopus/core` and shouldn't (registry is lower-level). Instead, accept a `noCache` option in the `SkillRegistry` constructor or the `load()` method.

Simpler approach: Add a static flag that the caller (CLI or engine) sets before calling `load()`.

Add to `SkillRegistry`:
```typescript
export class SkillRegistry {
  private skills: LoadedSkill[] = [];
  public noCache = false;
  // ... rest unchanged
```

Then in the `load()` method's cache check, replace `!process.env.OCTOPUS_NO_CACHE` with `!this.noCache`:
```typescript
    if (!this.noCache) {
```

Then in engine.ts and CLI index.ts, after creating the registry:
```typescript
const registry = new SkillRegistry(skillsDir, ratingsPath);
registry.noCache = config.registry.noCache;
await registry.load();
```

- [ ] **Step 2: Commit**

```bash
git add packages/registry/src/registry.ts packages/gateway/src/engine.ts apps/cli/src/index.ts
git commit -m "refactor(registry): use noCache property instead of env var

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
"
```

---

### Task 18: Update CLI index.ts

**Files:**
- Modify: `apps/cli/src/index.ts`

- [ ] **Step 1: Replace dotenv loading and bootstrap() with config resolver**

Remove lines 7 and 24-25 (`dotenv` import and config calls). Remove line 15 (`loadOctopusConfig` etc from config.ts import).

Replace the `bootstrap()` function (lines 161-203):

```typescript
import { loadConfig, getConfig, getConfigPath, getEnvPath, type CredentialMissingResult } from '@agentoctopus/core';

async function bootstrap() {
  const config = loadConfig();

  // Use registry paths from config, falling back to ~/.agentoctopus/ defaults
  const skillsDir = config.registry.skillsDir === './registry/skills'
    ? path.join(os.homedir(), '.agentoctopus', 'skills')
    : config.registry.skillsDir;
  const ratingsPath = config.registry.ratingsPath === './registry/ratings.json'
    ? path.join(os.homedir(), '.agentoctopus', 'ratings.json')
    : config.registry.ratingsPath;

  const registry = new SkillRegistry(skillsDir, ratingsPath);
  registry.noCache = config.registry.noCache;
  await registry.load();

  const chatConfig: LLMConfig = {
    provider: config.llm.provider,
    model: config.llm.model,
    apiKey: config.llm.apiKey || undefined,
    baseUrl: config.llm.baseUrl,
  };

  const embedConfig: LLMConfig | undefined =
    config.embed.apiKey
      ? { provider: config.embed.provider, model: config.embed.model, apiKey: config.embed.apiKey, baseUrl: config.embed.baseUrl || chatConfig.baseUrl }
      : undefined;

  const router = new Router(chatConfig, embedConfig);
  const chatClient = createChatClient(chatConfig);
  const executor = new Executor(registry, chatClient);

  return { registry, router, executor };
}
```

Replace all remaining `process.env` reads in the file:
- Line 102: `const rootDir = process.env.OCTOPUS_ROOT || process.cwd();` → `const rootDir = getConfig().deploy.root || process.cwd();`
- Line 122-123: `const rootDir = process.env.OCTOPUS_ROOT || process.cwd(); const port = Number(process.env.AGENT_GATEWAY_PORT ?? 3002);` → `const rootDir = getConfig().deploy.root || process.cwd(); const port = getConfig().gateway.port;`
- Lines 269, 317 (OCTOPUS_TIMING): `process.env.OCTOPUS_TIMING` → `getConfig().execution.timing`
- Remove the old `loadOctopusConfig()` and related code that merged credentials

For the `config set` and `config get` commands that wrote to octopus.json directly — update them to use `saveConfigFile()`.

- [ ] **Step 2: Commit**

```bash
git add apps/cli/src/index.ts
git commit -m "refactor(cli): use config resolver, load .env from ~/.agentoctopus

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
"
```

---

### Task 19: Update CLI onboard.ts

**Files:**
- Modify: `apps/cli/src/onboard.ts`

- [ ] **Step 1: Write to ~/.agentoctopus/.env and new octopus.json format**

Replace `generateEnvContent()` (lines 148-211) with a function that writes both `~/.agentoctopus/.env` and `~/.agentoctopus/octopus.json`:

```typescript
import { saveConfigFile, saveEnvFile, getConfigPath, getEnvPath, type OctopusConfigV2 } from '@agentoctopus/core';

function saveOnboardConfig(config: OnboardConfig): void {
  // Write .env with actual secret values
  const envLines: string[] = [
    '# AgentOctopus Configuration',
    `# Generated by octopus onboard on ${new Date().toISOString()}`,
    '',
  ];

  const v2: OctopusConfigV2 = { version: 2 };

  // LLM
  v2.llm = { provider: config.llmProvider, model: config.llmModel };
  if (config.llmProvider === 'openai') {
    envLines.push(`OPENAI_API_KEY=${config.openaiApiKey || ''}`);
    v2.llm.apiKey = '${OPENAI_API_KEY}';
    v2.llm.baseUrl = config.openaiBaseUrl || 'https://api.openai.com/v1';
  }
  if (config.llmProvider === 'gemini' || config.geminiApiKey) {
    envLines.push(`GEMINI_API_KEY=${config.geminiApiKey || ''}`);
    if (!config.openaiApiKey) v2.llm.apiKey = '${GEMINI_API_KEY}';
  }
  if (config.llmProvider === 'ollama') {
    v2.llm.baseUrl = config.ollamaBaseUrl || 'http://localhost:11434';
  }

  // Embed
  const ep = config.embedSameProvider ? config.llmProvider : (config.embedProvider || config.llmProvider);
  v2.embed = { provider: ep, model: config.embedModel || 'text-embedding-3-small' };
  if (!config.embedSameProvider) {
    envLines.push(`EMBED_API_KEY=${config.embedApiKey || ''}`);
    v2.embed.apiKey = '${EMBED_API_KEY}';
    if (config.embedBaseUrl) v2.embed.baseUrl = config.embedBaseUrl;
  } else {
    v2.embed.apiKey = v2.llm?.apiKey ?? '';
    v2.embed.baseUrl = v2.llm?.baseUrl ?? '';
  }

  // Rerank
  v2.rerank = { model: config.rerankModel || config.llmModel };

  // Deploy
  v2.deploy = { mode: (config.executionMode === 'cloud' ? 'cloud' : 'local') as 'local' | 'cloud', root: null };

  envLines.push('');
  saveEnvFile(envLines.join('\n') + '\n');
  saveConfigFile(v2);

  console.log(`Config written to ${getConfigPath()} and ${getEnvPath()}`);
}
```

Remove the old `generateEnvContent()` function and the old `.env` writing code. Update `runOnboarding()` to call `saveOnboardConfig()` instead of writing `.env`.

- [ ] **Step 2: Commit**

```bash
git add apps/cli/src/onboard.ts
git commit -m "refactor(cli): onboard writes to octopus.json + ~/.agentoctopus/.env

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
"
```

---

### Task 20: Update CLI connect.ts

**Files:**
- Modify: `apps/cli/src/connect.ts`

- [ ] **Step 1: Write to new octopus.json format**

Replace the old `saveOctopusConfig()` call (line 156) with new format:

```typescript
import { saveConfigFile, saveEnvFile, type OctopusConfigV2 } from '@agentoctopus/core';

// In connectOpenClaw(), replace lines 125-156:
const v2: OctopusConfigV2 = { version: 2 };

v2.llm = {
  provider: extracted.provider,
  model: extracted.model,
  apiKey: '${OPENAI_API_KEY}',
  baseUrl: extracted.baseUrl,
};

saveEnvFile(`OPENAI_API_KEY=${extracted.apiKey}\n`);

const supportsEmbedding = extracted.rawProvider !== 'openrouter';
if (supportsEmbedding) {
  const embedModelDefaults: Record<string, string> = { openai: 'text-embedding-3-small', gemini: 'text-embedding-004', ollama: 'nomic-embed-text' };
  v2.embed = {
    provider: extracted.provider,
    model: embedModelDefaults[extracted.rawProvider] ?? 'text-embedding-3-small',
    apiKey: '${OPENAI_API_KEY}',
    baseUrl: extracted.baseUrl,
  };
}

saveConfigFile(v2);

console.log(chalk.green('  AgentOctopus configured with your OpenClaw LLM settings.'));
// ... rest of function
```

- [ ] **Step 2: Commit**

```bash
git add apps/cli/src/connect.ts
git commit -m "refactor(cli): connect writes to v2 octopus.json format

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
"
```

---

### Task 21: Update CLI skill-create.ts

**Files:**
- Modify: `apps/cli/src/skill-create.ts`

- [ ] **Step 1: Replace env reads at lines 93, 180-185**

Replace line 93:
```typescript
  if (process.env.REGISTRY_PATH) return process.env.REGISTRY_PATH;
```
→
```typescript
  const registryDir = getConfig().registry.skillsDir;
  if (registryDir !== './registry/skills') return registryDir;
```

Replace lines 180-185 (LLM config for skill creation):
```typescript
import { getConfig } from '@agentoctopus/core';

function getLLMConfigForCreation(): LLMConfig {
  const c = getConfig();
  return {
    provider: c.llm.provider,
    model: c.llm.model,
    apiKey: c.llm.apiKey || undefined,
    baseUrl: c.llm.baseUrl,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/cli/src/skill-create.ts
git commit -m "refactor(cli): use config resolver in skill-create

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
"
```

---

### Task 22: Update web route.ts

**Files:**
- Modify: `apps/web/src/app/api/ask/route.ts`

- [ ] **Step 1: Replace process.env reads**

Replace the `initOctopus()` function (lines 26-55):

```typescript
import { Router, Executor, createChatClient, getConfig, loadConfig, type CredentialMissingResult, type BinaryMissingResult } from '@agentoctopus/core';

async function initOctopus() {
  if (!isInitialized) {
    const config = loadConfig();

    await registry.load();

    const chatConfig = {
      provider: config.llm.provider,
      model: config.llm.model,
      apiKey: config.llm.apiKey || undefined,
      baseUrl: config.llm.baseUrl,
    };

    const embedConfig = {
      provider: config.embed.provider,
      model: config.embed.model,
      apiKey: config.embed.apiKey || chatConfig.apiKey,
      baseUrl: config.embed.baseUrl || chatConfig.baseUrl,
    };

    const rerankConfig = {
      ...embedConfig,
      model: config.rerank.model,
    };

    router = new Router(rerankConfig, embedConfig);
    await router.buildIndex(registry.getAll());
    executor = new Executor(registry);
    chatClient = createChatClient(rerankConfig);
    isInitialized = true;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/app/api/ask/route.ts
git commit -m "refactor(web): use config resolver in ask route

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
"
```

---

### Task 23: Remove old config files

**Files:**
- Delete: `apps/cli/src/config.ts`
- Delete: `apps/web/.env`

- [ ] **Step 1: Delete the files and fix imports**

```bash
rm apps/cli/src/config.ts
rm apps/web/.env
```

Ensure no remaining imports reference `apps/cli/src/config.ts`. Grep for `from './config.js'` in CLI source:
```bash
grep -r "from.*config\.js" apps/cli/src/
```

If any remain, fix them to import from `@agentoctopus/core` instead.

- [ ] **Step 2: Commit**

```bash
git rm apps/cli/src/config.ts apps/web/.env
# Fix any remaining imports if needed
git commit -m "refactor: remove old config.ts and web/.env, superseded by resolver

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
"
```

---

### Task 24: Migrate local .env to ~/.agentoctopus/.env

**Files:**
- Modify: `.env` (project root)

- [ ] **Step 1: Copy .env content to ~/.agentoctopus/.env, clear project .env**

Read the current `.env` and write its content to `~/.agentoctopus/.env`:

```bash
mkdir -p ~/.agentoctopus
cp .env ~/.agentoctopus/.env
```

Then clear `.env` of secrets and replace with a comment:
```bash
echo '# AgentOctopus config now lives at ~/.agentoctopus/octopus.json' > .env
echo '# Secrets are in ~/.agentoctopus/.env' >> .env
```

- [ ] **Step 2: Create octopus.json from current .env**

Create `~/.agentoctopus/octopus.json` with references to the env vars:

```json
{
  "version": 2,
  "llm": {
    "provider": "openai",
    "model": "qwen/qwen3.6-plus-preview:free",
    "apiKey": "${OPENAI_API_KEY}",
    "baseUrl": "https://openrouter.ai/api/v1"
  },
  "embed": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "apiKey": "${EMBED_API_KEY}",
    "baseUrl": "https://api.chatanywhere.tech"
  },
  "rerank": {
    "model": "gpt-4o-mini"
  },
  "registry": {
    "skillsDir": "./registry/skills",
    "ratingsPath": "./registry/ratings.json"
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add .env
git commit -m "refactor: move secrets to ~/.agentoctopus/.env, add octopus.json

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
"
```

---

### Task 25: Write and run tests

**Files:**
- Create: `packages/core/tests/config-resolver.test.ts`

- [ ] **Step 1: Write config resolver tests**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { resetConfig, loadConfig, getConfig, getConfigDir } from '../src/config-resolver.js';

const TEST_DIR = path.join(os.tmpdir(), 'agentoctopus-test-' + Date.now());
const TEST_HOME = path.join(TEST_DIR, 'home');

// Override homedir for tests
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => TEST_HOME, default: { ...actual, homedir: () => TEST_HOME } };
});

beforeEach(() => {
  resetConfig();
  if (fs.existsSync(TEST_HOME)) fs.rmSync(TEST_HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_HOME, '.agentoctopus'), { recursive: true });
});

afterEach(() => {
  resetConfig();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('ConfigResolver', () => {
  it('returns defaults when no config files exist', () => {
    // Remove any existing config dir
    fs.rmSync(path.join(TEST_HOME, '.agentoctopus'), { recursive: true, force: true });
    const config = loadConfig();
    expect(config.llm.provider).toBe('openai');
    expect(config.llm.model).toBe('gpt-4o');
    expect(config.llm.apiKey).toBe('');
    expect(config.gateway.port).toBe(3002);
    expect(config.execution.timeoutMs).toBe(30000);
    expect(config.deploy.mode).toBe('local');
  });

  it('resolves ${VAR} references from .env', () => {
    fs.writeFileSync(
      path.join(TEST_HOME, '.agentoctopus', '.env'),
      'OPENAI_API_KEY=sk-test123\n',
    );
    fs.writeFileSync(
      path.join(TEST_HOME, '.agentoctopus', 'octopus.json'),
      JSON.stringify({
        version: 2,
        llm: { provider: 'openai', model: 'gpt-4o', apiKey: '${OPENAI_API_KEY}' },
      }),
    );

    const config = loadConfig();
    expect(config.llm.apiKey).toBe('sk-test123');
  });

  it('returns empty string for unresolved ${VAR}', () => {
    fs.writeFileSync(
      path.join(TEST_HOME, '.agentoctopus', 'octopus.json'),
      JSON.stringify({
        version: 2,
        llm: { apiKey: '${MISSING_VAR}' },
      }),
    );

    const config = loadConfig();
    expect(config.llm.apiKey).toBe('');
  });

  it('migrates v1 config to v2', () => {
    fs.writeFileSync(
      path.join(TEST_HOME, '.agentoctopus', 'octopus.json'),
      JSON.stringify({
        skillsDir: '/custom/skills',
        ratingsPath: '/custom/ratings.json',
        credentials: {
          LLM_PROVIDER: 'openai',
          LLM_MODEL: 'gpt-4o',
          OPENAI_API_KEY: 'sk-migrated',
          OPENAI_BASE_URL: 'https://custom.api.com/v1',
        },
        gistId: 'abc123',
        maxRetries: 5,
      }),
    );

    const config = loadConfig();
    expect(config.llm.provider).toBe('openai');
    expect(config.llm.model).toBe('gpt-4o');
    expect(config.registry.skillsDir).toBe('/custom/skills');
    expect(config.rating.gistId).toBe('abc123');
    expect(config.execution.maxRetries).toBe(5);

    // Secrets should have been extracted to .env
    const envContent = fs.readFileSync(path.join(TEST_HOME, '.agentoctopus', '.env'), 'utf8');
    expect(envContent).toContain('OPENAI_API_KEY=sk-migrated');

    // Config should have ${VAR} reference
    const configFile = JSON.parse(fs.readFileSync(path.join(TEST_HOME, '.agentoctopus', 'octopus.json'), 'utf8'));
    expect(configFile.llm.apiKey).toBe('${OPENAI_API_KEY}');
  });

  it('caches config on subsequent calls', () => {
    const a = loadConfig();
    const b = loadConfig();
    expect(a).toBe(b);
  });

  it('respects override=false for .env (existing env wins)', () => {
    process.env.TEST_VAR = 'from-process';
    fs.writeFileSync(
      path.join(TEST_HOME, '.agentoctopus', '.env'),
      'TEST_VAR=from-file\n',
    );
    fs.writeFileSync(
      path.join(TEST_HOME, '.agentoctopus', 'octopus.json'),
      JSON.stringify({ version: 2 }),
    );

    loadConfig();
    // dotenv with override=false should NOT overwrite existing process.env
    expect(process.env.TEST_VAR).toBe('from-process');
    delete process.env.TEST_VAR;
  });

  it('filters unknown keys via Zod', () => {
    fs.writeFileSync(
      path.join(TEST_HOME, '.agentoctopus', 'octopus.json'),
      JSON.stringify({
        version: 2,
        llm: { provider: 'openai', model: 'gpt-4o', unknownKey: 'should-be-stripped' },
      }),
    );

    const config = loadConfig();
    expect(config.llm.provider).toBe('openai');
    expect((config.llm as Record<string, unknown>).unknownKey).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests**

```bash
pnpm --filter @agentoctopus/core test
```

Expected: 6 new tests pass plus existing tests still pass.

- [ ] **Step 3: Commit**

```bash
git add packages/core/tests/config-resolver.test.ts
git commit -m "test(core): add config resolver tests

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
"
```

---

### Task 26: Build and run all tests

**Files:** (none — verification only)

- [ ] **Step 1: Build all packages**

```bash
pnpm build
```

Expected: Clean build with no TypeScript errors.

- [ ] **Step 2: Run all tests**

```bash
pnpm test
```

Expected: All existing tests pass + new config resolver tests pass.

- [ ] **Step 3: Smoke test CLI**

```bash
node apps/cli/dist/index.js list
```

Expected: CLI starts without "SessionStart hook" or other errors, lists skills normally.

- [ ] **Step 4: Commit any final fixes**

If anything fails, fix and commit. Otherwise, the branch is ready.
