// All public types for the skills package

// --- Install spec (from SKILL.md install: or openclaw.install:) ---

export interface SkillInstallSpec {
  id?: string;
  label?: string;
  bins?: string[];
  kind: "brew" | "node" | "go" | "uv" | "download";
  os?: string[];
  formula?: string;
  package?: string;
  module?: string;
  url?: string;
  archive?: string;
  extract?: boolean;
  stripComponents?: number;
  targetDir?: string;
}

// --- Requires block (runtime eligibility) ---

export interface SkillRequires {
  bins?: string[];
  anyBins?: string[];
  env?: string[];
  config?: string[];
}

// --- Parsed metadata (merged flat + openclaw block) ---

export interface SkillMetadata {
  always?: boolean;
  skillKey?: string;
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  os?: string[];
  requires?: SkillRequires;
  install?: SkillInstallSpec[];
}

// --- Invocation policy ---

export interface SkillInvocationPolicy {
  userInvocable: boolean;
  disableModelInvocation: boolean;
}

// --- Skill definition (the raw SKILL.md content) ---

export interface Skill {
  name: string;
  description: string;
  version: string;
  dirPath: string;
  source: SkillSource;
  tags: string[];
  instructions: string;
  frontmatter: Record<string, unknown>;
}

export type SkillSource = "user" | "project" | "clawhub" | "plugin" | "pack" | "bundled";

// --- The fully resolved entry ---

export interface SkillEntry {
  skill: Skill;
  frontmatter: Record<string, unknown>;
  metadata: SkillMetadata;
  invocation: SkillInvocationPolicy;
  exposure?: SkillExposure;
  routingScore?: number;
}

// --- Eligibility context (injected by caller) ---

export interface SkillEligibilityContext {
  hasBin: (bin: string) => boolean;
  hasAnyBin: (bins: string[]) => boolean;
  hasEnv: (key: string) => boolean;
  isConfigPathTruthy: (path: string) => boolean;
  os: string;
  remote?: {
    platforms: string[];
    hasBin: (bin: string) => boolean;
    hasAnyBin: (bins: string[]) => boolean;
  };
}

// --- What callers see after filtering ---

export interface SkillExposure {
  includeInRuntimeRegistry: boolean;
  includeInAvailableSkillsPrompt: boolean;
  userInvocable: boolean;
}

// --- Snapshot (the prompt block + metadata) ---

export interface SkillSnapshot {
  prompt: string;
  skills: Array<{ name: string; primaryEnv?: string; requiredEnv?: string[] }>;
  skillFilter?: string[];
  resolvedSkills: Skill[];
  version: number;
}

// --- Per-skill config from octopus.json ---

export interface SkillConfig {
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
  config?: Record<string, unknown>;
}

// --- Skills section of octopus.json ---

export interface SkillsConfig {
  allowBundled?: string[];
  entries?: Record<string, SkillConfig>;
  load?: {
    extraDirs?: string[];
    watch?: boolean;
    watchDebounceMs?: number;
  };
  limits?: {
    maxSkillsInPrompt?: number;
    maxSkillsPromptChars?: number;
    maxSkillFileBytes?: number;
  };
  packs?: string[];
}

// --- Install result ---

export interface InstallResult {
  installed: string[];
  skipped: string[];
  errors: string[];
}

// --- Command spec for CLI registration ---

export interface SkillCommandSpec {
  name: string;
  description: string;
  skillName: string;
}

// --- Routing score provider (injected, avoids circular dep on registry) ---

export interface RoutingScoreProvider {
  getRoutingScore(skillName: string, taskType?: string): number;
}
