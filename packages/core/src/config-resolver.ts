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
  if (typeof raw.maxRetries === 'number') v2.execution = { ...v2.execution, maxRetries: raw.maxRetries };

  if (envLines.length > 1) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(path.join(CONFIG_DIR, '.env'), envLines.join('\n') + '\n', 'utf8');
  }
  return v2;
}

export function loadConfig(): ResolvedConfig {
  if (_config) return _config;

  const envPath = path.join(CONFIG_DIR, '.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }

  let raw: Record<string, unknown> | null = null;
  if (fs.existsSync(CONFIG_PATH)) {
    try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {
      console.warn(`[ConfigResolver] Failed to parse ${CONFIG_PATH}, using defaults.`);
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
