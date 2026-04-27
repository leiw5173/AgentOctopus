import type { SkillsConfig, SkillConfig } from "./types.js";

export function resolveSkillConfig(
  config: SkillsConfig | undefined,
  skillKey: string,
): SkillConfig | undefined {
  if (!config?.entries) return undefined;
  return config.entries[skillKey];
}
