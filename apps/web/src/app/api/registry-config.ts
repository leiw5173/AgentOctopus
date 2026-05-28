import path from 'path';
import { loadConfig, getConfigDir } from '@agentoctopus/core';
import { SkillRegistry } from '@agentoctopus/registry';

export function createConfiguredRegistry(): SkillRegistry {
  const config = loadConfig();
  const configDir = getConfigDir();

  // Resolve registry paths relative to the config directory,
  // not CWD — on Vercel, CWD is the repo root but the config
  // and skills live under apps/web/.agentoctopus/.
  const resolveFromConfigDir = (p: string) =>
    path.isAbsolute(p) ? p : path.resolve(configDir, p);

  const registry = new SkillRegistry(
    resolveFromConfigDir(config.registry.skillsDir),
    resolveFromConfigDir(config.registry.ratingsPath),
  );
  registry.noCache = config.registry.noCache;
  return registry;
}
