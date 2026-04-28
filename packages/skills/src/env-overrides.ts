import type { SkillEntry, SkillsConfig } from "./types.js";
import { resolveSkillConfig } from "./config.js";

const DANGEROUS_KEY_PATTERN = /^OPENSSL_CONF$/i;

export function applySkillEnvOverrides(
  entries: SkillEntry[],
  skillsConfig: SkillsConfig | undefined,
): () => void {
  const applied: string[] = [];

  for (const entry of entries) {
    const skillKey = entry.metadata.skillKey ?? entry.skill.name;
    const config = resolveSkillConfig(skillsConfig, skillKey);
    if (!config) continue;

    if (entry.metadata.primaryEnv && config.apiKey) {
      const key = entry.metadata.primaryEnv;
      if (!DANGEROUS_KEY_PATTERN.test(key)) {
        if (!(key in process.env)) {
          process.env[key] = config.apiKey;
          applied.push(key);
        }
      }
    }

    if (config.env) {
      for (const [key, value] of Object.entries(config.env)) {
        if (!DANGEROUS_KEY_PATTERN.test(key)) {
          if (!(key in process.env) && value !== undefined) {
            process.env[key] = value;
            applied.push(key);
          }
        }
      }
    }
  }

  return () => {
    for (const key of applied) {
      delete process.env[key];
    }
  };
}
