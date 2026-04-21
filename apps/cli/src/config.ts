import fs from 'fs';
import path from 'path';
import os from 'os';

export interface OctopusConfig {
  skillsDir: string;
  ratingsPath: string;
  credentials: Record<string, string>;
  gistId?: string;
  feedbackSharing?: boolean;
  /** Max skills to try on execution failure (default: 3) */
  maxRetries?: number;
}

const DEFAULT_HOME = path.join(os.homedir(), '.agentoctopus');
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_HOME, 'octopus.json');

export function getDefaultHome(): string {
  return DEFAULT_HOME;
}

export function getDefaultSkillsDir(): string {
  return path.join(DEFAULT_HOME, 'skills');
}

export function getDefaultRatingsPath(): string {
  return path.join(DEFAULT_HOME, 'ratings.json');
}

export function getConfigPath(): string {
  return DEFAULT_CONFIG_PATH;
}

export function loadOctopusConfig(): OctopusConfig | null {
  if (!fs.existsSync(DEFAULT_CONFIG_PATH)) return null;
  try {
    const raw = fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8');
    return JSON.parse(raw) as OctopusConfig;
  } catch {
    return null;
  }
}

export function saveOctopusConfig(config: OctopusConfig): void {
  fs.mkdirSync(DEFAULT_HOME, { recursive: true });
  fs.writeFileSync(DEFAULT_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

export function defaultConfig(skillsDir?: string): OctopusConfig {
  const home = DEFAULT_HOME;
  return {
    skillsDir: skillsDir ?? path.join(home, 'skills'),
    ratingsPath: path.join(home, 'ratings.json'),
    credentials: {},
  };
}
