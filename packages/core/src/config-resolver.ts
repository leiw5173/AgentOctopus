import fs from 'fs';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';
import {
  OctopusConfigV2Schema, LLMConfigSchema, EmbedConfigSchema,
  RerankConfigSchema, GatewayConfigSchema, RegistryConfigSchema,
  ExecutionConfigSchema, DeployConfigSchema, AuthConfigSchema,
  RatingConfigSchema, SlackConfigSchema, SkillsConfigSchema,
  EvolutionConfigSchema, AgentsConfigSchema, SandboxConfigSchema,
  CanvasConfigSchema, CompanionConfigSchema,
  type ResolvedConfig, type OctopusConfigV2,
} from './config-types.js';

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.agentoctopus');

let _config: ResolvedConfig | null = null;

function findProjectConfigDir(): string | null {
  const webAppCandidate = path.join(process.cwd(), 'apps', 'web', '.agentoctopus');
  if (fs.existsSync(path.join(webAppCandidate, 'octopus.json'))) return webAppCandidate;

  let current = process.cwd();
  while (true) {
    const candidate = path.join(current, '.agentoctopus');
    if (fs.existsSync(path.join(candidate, 'octopus.json'))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function getConfigDirInternal(): string {
  const defaultConfigPath = path.join(DEFAULT_CONFIG_DIR, 'octopus.json');
  return envString('AGENTOCTOPUS_CONFIG_DIR')
    ?? envString('AGENTOCTOPUS_HOME')
    ?? (fs.existsSync(defaultConfigPath) ? DEFAULT_CONFIG_DIR : undefined)
    ?? findProjectConfigDir()
    ?? DEFAULT_CONFIG_DIR;
}

function getConfigPathInternal(): string {
  return path.join(getConfigDirInternal(), 'octopus.json');
}

function resolveEnvRef(value: string): string {
  const m = value.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/);
  return m ? (process.env[m[1]] ?? '') : value;
}

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

function mergeSection<T>(schema: { parse(i: unknown): T }, partial: Record<string, unknown> | undefined): T {
  return schema.parse(partial && Object.keys(partial).length > 0 ? partial : {});
}

function envString(key: string): string | undefined {
  const value = process.env[key];
  return value && value.trim() !== '' ? value : undefined;
}

function envProvider(key: string): 'openai' | 'gemini' | 'ollama' | 'anthropic' | undefined {
  const value = envString(key);
  return value === 'openai' || value === 'gemini' || value === 'ollama' || value === 'anthropic'
    ? value
    : undefined;
}

function applyEnvConfig(resolved: ResolvedConfig): ResolvedConfig {
  const llmProvider = envProvider('LLM_PROVIDER') ?? resolved.llm.provider;
  const embedProvider = envProvider('EMBED_PROVIDER') ?? resolved.embed.provider;
  const llmApiKey = envString('LLM_API_KEY')
    ?? (llmProvider === 'openai' ? envString('OPENAI_API_KEY') : undefined)
    ?? (llmProvider === 'gemini' ? envString('GEMINI_API_KEY') : undefined)
    ?? resolved.llm.apiKey;
  const llmBaseUrl = envString('LLM_BASE_URL')
    ?? (llmProvider === 'openai' ? envString('OPENAI_BASE_URL') : undefined)
    ?? resolved.llm.baseUrl;
  const embedApiKey = envString('EMBED_API_KEY')
    ?? (embedProvider === 'openai' ? envString('OPENAI_API_KEY') : undefined)
    ?? (embedProvider === 'gemini' ? envString('GEMINI_API_KEY') : undefined)
    ?? llmApiKey
    ?? resolved.embed.apiKey;
  const embedBaseUrl = envString('EMBED_BASE_URL')
    ?? (embedProvider === 'openai' ? envString('OPENAI_BASE_URL') : undefined)
    ?? llmBaseUrl
    ?? resolved.embed.baseUrl;

  return {
    ...resolved,
    llm: {
      ...resolved.llm,
      provider: llmProvider,
      model: envString('LLM_MODEL') ?? resolved.llm.model,
      apiKey: llmApiKey,
      baseUrl: llmBaseUrl,
    },
    embed: {
      ...resolved.embed,
      provider: embedProvider,
      model: envString('EMBED_MODEL') ?? resolved.embed.model,
      apiKey: embedApiKey,
      baseUrl: embedBaseUrl,
    },
    rerank: {
      ...resolved.rerank,
      model: envString('RERANK_MODEL') ?? resolved.rerank.model,
    },
  };
}

function migrateV1ToV2(raw: Record<string, unknown>): OctopusConfigV2 {
  const creds = (raw.credentials as Record<string, string>) ?? {};
  const envLines: string[] = ['# AgentOctopus — migrated from octopus.json v1'];
  const v2: OctopusConfigV2 = { version: 2 };

  if (creds.LLM_PROVIDER) v2.llm = { ...v2.llm, provider: creds.LLM_PROVIDER as 'openai' | 'gemini' | 'ollama' };
  if (creds.LLM_MODEL) v2.llm = { ...v2.llm, model: creds.LLM_MODEL };
  if (creds.OPENAI_API_KEY) { v2.llm = { ...v2.llm, apiKey: '${OPENAI_API_KEY}' }; envLines.push(`OPENAI_API_KEY=${creds.OPENAI_API_KEY}`); }
  if (creds.OPENAI_BASE_URL) v2.llm = { ...v2.llm, baseUrl: creds.OPENAI_BASE_URL };
  if (creds.GEMINI_API_KEY) { envLines.push(`GEMINI_API_KEY=${creds.GEMINI_API_KEY}`); }
  if (creds.EMBED_PROVIDER) v2.embed = { ...v2.embed, provider: creds.EMBED_PROVIDER as 'openai' | 'gemini' | 'ollama' };
  if (creds.EMBED_MODEL) v2.embed = { ...v2.embed, model: creds.EMBED_MODEL };
  if (creds.EMBED_API_KEY) { v2.embed = { ...v2.embed, apiKey: '${EMBED_API_KEY}' }; envLines.push(`EMBED_API_KEY=${creds.EMBED_API_KEY}`); }
  if (creds.EMBED_BASE_URL) v2.embed = { ...v2.embed, baseUrl: creds.EMBED_BASE_URL };

  if (typeof raw.skillsDir === 'string') v2.registry = { ...v2.registry, skillsDir: raw.skillsDir };
  if (typeof raw.ratingsPath === 'string') v2.registry = { ...v2.registry, ratingsPath: raw.ratingsPath };
  if (typeof raw.gistId === 'string') v2.rating = { ...v2.rating, gistId: raw.gistId };
  if (typeof raw.feedbackSharing === 'boolean') v2.rating = { ...v2.rating, feedbackSharing: raw.feedbackSharing };
  if (typeof raw.deviceId === 'string') v2.rating = { ...v2.rating, deviceId: raw.deviceId };
  if (typeof raw.maxRetries === 'number') v2.execution = { ...v2.execution, maxRetries: raw.maxRetries };

  if (envLines.length > 1) {
    const configDir = getConfigDirInternal();
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.env'), envLines.join('\n') + '\n', 'utf8');
  }
  return v2;
}

export function loadConfig(): ResolvedConfig {
  if (_config) return _config;

  const configDir = getConfigDirInternal();
  const configPath = getConfigPathInternal();
  const envPath = path.join(configDir, '.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }

  let raw: Record<string, unknown> | null = null;
  if (fs.existsSync(configPath)) {
    try { raw = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {
      console.warn(`[ConfigResolver] Failed to parse ${configPath}, using defaults.`);
    }
  }

  let configObj: Record<string, unknown>;
  if (!raw) {
    configObj = { version: 2 };
    console.warn('[ConfigResolver] No octopus.json found. Run `octopus onboard` to configure.');
  } else if (raw.version === 2) {
    configObj = raw;
  } else {
    configObj = migrateV1ToV2(raw) as unknown as Record<string, unknown>;
  }

  const parsed = OctopusConfigV2Schema.parse(configObj) as unknown as Record<string, Record<string, unknown> | undefined>;

  const resolved: ResolvedConfig = applyEnvConfig({
    credentials: resolveAllEnvRefs((parsed.credentials ?? {}) as Record<string, string>),
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
    skills: resolveAllEnvRefs(mergeSection(SkillsConfigSchema, parsed.skills)),
    evolution: resolveAllEnvRefs(mergeSection(EvolutionConfigSchema, parsed.evolution)),
    agents: resolveAllEnvRefs(mergeSection(AgentsConfigSchema, parsed.agents)),
    sandbox: resolveAllEnvRefs(mergeSection(SandboxConfigSchema, parsed.sandbox)),
    canvas: resolveAllEnvRefs(mergeSection(CanvasConfigSchema, parsed.canvas)),
    companion: resolveAllEnvRefs(mergeSection(CompanionConfigSchema, parsed.companion)),
  });

  if (raw && raw.version !== 2) {
    try { saveConfigFile(configObj as unknown as OctopusConfigV2); } catch { /* non-fatal */ }
  }

  _config = Object.freeze(resolved) as ResolvedConfig;
  return _config;
}

export function getConfig(): ResolvedConfig {
  return _config ?? loadConfig();
}

export function resetConfig(): void {
  _config = null;
}

export function getConfigDir(): string { return getConfigDirInternal(); }
export function getConfigPath(): string { return getConfigPathInternal(); }
export function getEnvPath(): string { return path.join(getConfigDirInternal(), '.env'); }

export function saveConfigFile(config: OctopusConfigV2): void {
  const configPath = getConfigPathInternal();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

export function saveEnvFile(content: string): void {
  const configDir = getConfigDirInternal();
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(getEnvPath(), content, 'utf8');
}

export function getInstallPref(bin: string): 'always' | 'never' | 'prompt' {
  const config = getConfig();
  return (config.skills.installPrefs?.[bin] as 'always' | 'never' | 'prompt') ?? 'prompt';
}

export function saveInstallPref(bins: string[], preference: 'always' | 'never'): void {
  const rawPath = getConfigPath();
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(rawPath)) {
    try { raw = JSON.parse(fs.readFileSync(rawPath, 'utf8')); } catch { /* ignore */ }
  }

  if (!raw.skills || typeof raw.skills !== 'object') {
    raw.skills = {};
  }
  const skills = raw.skills as Record<string, unknown>;
  if (!skills.installPrefs || typeof skills.installPrefs !== 'object') {
    skills.installPrefs = {};
  }
  const prefs = skills.installPrefs as Record<string, string>;

  for (const bin of bins) {
    prefs[bin] = preference;
  }

  fs.mkdirSync(path.dirname(rawPath), { recursive: true });
  fs.writeFileSync(rawPath, JSON.stringify(raw, null, 2), 'utf8');

  // Invalidate in-memory cache so next getConfig() sees the update
  resetConfig();
}
