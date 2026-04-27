import type { SkillEntry, SkillSnapshot } from "./types.js";

let versionCounter = 0;

export interface SnapshotLimits {
  maxSkillsInPrompt?: number;
  maxSkillsPromptChars?: number;
}

const DEFAULT_LIMITS: Required<SnapshotLimits> = {
  maxSkillsInPrompt: 150,
  maxSkillsPromptChars: 18_000,
};

export function buildWorkspaceSkillSnapshot(
  entries: SkillEntry[],
  limits?: SnapshotLimits,
): SkillSnapshot {
  const lim = { ...DEFAULT_LIMITS, ...limits };

  const visible = entries
    .filter(e => e.exposure?.includeInAvailableSkillsPrompt !== false)
    .slice(0, lim.maxSkillsInPrompt);

  let prompt = formatSkillsPrompt(visible);

  if (prompt.length > lim.maxSkillsPromptChars) {
    prompt = formatSkillsCompact(visible, lim.maxSkillsPromptChars);
  }

  const skills = visible.map(e => ({
    name: e.skill.name,
    primaryEnv: e.metadata.primaryEnv,
    requiredEnv: e.metadata.requires?.env,
  }));

  return {
    prompt,
    skills,
    resolvedSkills: visible.map(e => e.skill),
    version: ++versionCounter,
  };
}

function formatSkillsPrompt(entries: SkillEntry[]): string {
  const lines = ["<available_skills>"];
  for (const entry of entries) {
    const loc = entry.skill.dirPath.replace(process.env.HOME ?? "", "~");
    lines.push("  <skill>");
    lines.push(`    <name>${entry.skill.name}</name>`);
    lines.push(`    <description>${entry.skill.description}</description>`);
    lines.push(`    <location>${loc}/SKILL.md</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

function formatSkillsCompact(entries: SkillEntry[], maxChars: number): string {
  const lines = ["<available_skills>"];
  for (const entry of entries) {
    const loc = entry.skill.dirPath.replace(process.env.HOME ?? "", "~");
    lines.push(`  <skill><name>${entry.skill.name}</name><location>${loc}/SKILL.md</location></skill>`);
  }
  lines.push("</available_skills>");
  const full = lines.join("\n");
  if (full.length <= maxChars) return full;

  let lo = 0, hi = entries.length;
  let best = "<available_skills>\n</available_skills>";
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const subset = entries.slice(0, mid);
    const candidate = formatSkillsCompact(subset, Infinity);
    if (candidate.length <= maxChars) { best = candidate; lo = mid + 1; }
    else { hi = mid; }
  }
  return best;
}
