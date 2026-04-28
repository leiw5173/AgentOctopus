import { loadSkillsFromDir } from "./local-loader.js";
import { shouldIncludeSkill } from "./config.js";
import type { SkillEntry, SkillSource, SkillsConfig, SkillEligibilityContext } from "./types.js";

export interface WorkspaceSource {
  dirPath: string;
  source: SkillSource;
}

export interface WorkspaceOptions {
  config: SkillsConfig | undefined;
  eligibility: SkillEligibilityContext;
  routingScoreProvider?: {
    getRoutingScore(skillName: string, taskType?: string): number;
  };
}

/**
 * Priority merge: each subsequent source overwrites earlier ones by skill.name.
 * Sources are listed from lowest to highest priority (last wins).
 */
export function mergeByPriority(skillArrays: SkillEntry[][]): SkillEntry[] {
  const map = new Map<string, SkillEntry>();
  for (const skills of skillArrays) {
    for (const entry of skills) {
      map.set(entry.skill.name, entry);
    }
  }
  return Array.from(map.values());
}

/**
 * Load skills from all configured sources, apply priority merge,
 * filter via shouldIncludeSkill, and compute exposure.
 */
export async function loadWorkspaceSkills(
  sources: WorkspaceSource[],
  opts: WorkspaceOptions,
): Promise<SkillEntry[]> {
  const skillArrays = await Promise.all(
    sources.map(s => loadSkillsFromDir(s.dirPath, s.source)),
  );

  const merged = mergeByPriority(skillArrays);

  const result: SkillEntry[] = [];
  for (const entry of merged) {
    const eligible = shouldIncludeSkill({
      entry,
      config: opts.config,
      eligibility: opts.eligibility,
    });

    if (!eligible) continue;

    entry.exposure = {
      includeInRuntimeRegistry: true,
      includeInAvailableSkillsPrompt: !entry.invocation.disableModelInvocation,
      userInvocable: entry.invocation.userInvocable,
    };

    if (opts.routingScoreProvider) {
      entry.routingScore = opts.routingScoreProvider.getRoutingScore(entry.skill.name);
    }

    result.push(entry);
  }

  return result;
}
