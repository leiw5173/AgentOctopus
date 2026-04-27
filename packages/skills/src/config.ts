import type { SkillsConfig, SkillConfig, SkillEntry, SkillEligibilityContext } from "./types.js";

export function resolveSkillConfig(
  config: SkillsConfig | undefined,
  skillKey: string,
): SkillConfig | undefined {
  if (!config?.entries) return undefined;
  return config.entries[skillKey];
}

/**
 * Full eligibility check. Called at two points:
 * 1. Workspace loading (pre-route filter)
 * 2. Executor (per-invocation re-check)
 */
export function shouldIncludeSkill(params: {
  entry: SkillEntry;
  config: SkillsConfig | undefined;
  eligibility: SkillEligibilityContext;
}): boolean {
  const { entry, config, eligibility } = params;
  const skillKey = entry.metadata.skillKey ?? entry.skill.name;

  const skillConfig = resolveSkillConfig(config, skillKey);
  if (skillConfig?.enabled === false) return false;

  if (!isBundledSkillAllowed(entry, config)) return false;

  if (!evaluateRuntimeEligibility(entry, eligibility)) return false;

  return true;
}

export function isBundledSkillAllowed(
  entry: SkillEntry,
  config: SkillsConfig | undefined,
): boolean {
  if (entry.skill.source !== "bundled") return true;
  const allowBundled = config?.allowBundled;
  if (allowBundled === undefined) return true;
  if (allowBundled.length === 0) return false;
  const skillKey = entry.metadata.skillKey ?? entry.skill.name;
  return allowBundled.includes(entry.skill.name) || allowBundled.includes(skillKey);
}

export function evaluateRuntimeEligibility(
  entry: SkillEntry,
  ctx: SkillEligibilityContext,
): boolean {
  const m = entry.metadata;

  if (m.always === true) return true;

  if (m.os && m.os.length > 0) {
    if (!m.os.includes(ctx.os)) return false;
  }

  const req = m.requires;
  if (req) {
    if (req.bins) {
      for (const bin of req.bins) {
        if (!ctx.hasBin(bin)) return false;
      }
    }
    if (req.anyBins) {
      if (!ctx.hasAnyBin(req.anyBins)) return false;
    }
    if (req.env) {
      for (const env of req.env) {
        if (!ctx.hasEnv(env)) return false;
      }
    }
    if (req.config) {
      for (const configPath of req.config) {
        if (!ctx.isConfigPathTruthy(configPath)) return false;
      }
    }
  }

  return true;
}
