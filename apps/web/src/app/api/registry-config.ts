import path from 'path';
import { loadConfig } from '@agentoctopus/core';
import { SkillRegistry } from '@agentoctopus/registry';

export function resolveAppPath(configPath: string): string {
  return path.isAbsolute(configPath) ? configPath : path.resolve(process.cwd(), configPath);
}

export function createConfiguredRegistry(): SkillRegistry {
  const config = loadConfig();
  const registry = new SkillRegistry(
    resolveAppPath(config.registry.skillsDir),
    resolveAppPath(config.registry.ratingsPath),
  );
  registry.noCache = config.registry.noCache;
  return registry;
}
