import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { loadConfig, getConfigDir } from '@agentoctopus/core';
import { SkillRegistry } from '@agentoctopus/registry';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..', '..', '..');

export function createConfiguredRegistry(): SkillRegistry {
  const config = loadConfig();
  const configDir = getConfigDir();

  // Resolve a config path trying multiple bases: configDir → appRoot → CWD
  const resolvePath = (configured: string): string => {
    if (path.isAbsolute(configured)) return configured;

    const candidates = [
      path.resolve(configDir, configured),
      path.resolve(appRoot, configured),
      path.resolve(process.cwd(), configured),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    console.error(
      `[registry-config] Path not found: ${configured}\n  Tried: ${candidates.join('\n  ')}\n  configDir=${configDir}  cwd=${process.cwd()}  appRoot=${appRoot}`,
    );
    return candidates[0]!;
  };

  const skillsDir = resolvePath(config.registry.skillsDir);
  const ratingsPath = resolvePath(config.registry.ratingsPath);

  console.error(`[registry-config] skillsDir=${skillsDir} (${fs.existsSync(skillsDir) ? 'exists' : 'MISSING'})`);

  const registry = new SkillRegistry(skillsDir, ratingsPath);
  registry.noCache = config.registry.noCache;
  return registry;
}
