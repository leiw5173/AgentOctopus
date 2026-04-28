import type { SkillEntry, SkillCommandSpec } from "./types.js";

export function buildWorkspaceSkillCommandSpecs(entries: SkillEntry[]): SkillCommandSpec[] {
  const invocable = entries.filter(e => e.invocation.userInvocable);

  const sanitize = (name: string): string =>
    name.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 32);

  const usedNames = new Set<string>();
  const result: SkillCommandSpec[] = [];

  for (const entry of invocable) {
    let base = sanitize(entry.skill.name);
    let name = base;
    let suffix = 2;
    while (usedNames.has(name)) {
      name = `${base}_${suffix}`;
      suffix++;
    }
    usedNames.add(name);

    const desc = entry.skill.description.length > 100
      ? entry.skill.description.slice(0, 97) + "..."
      : entry.skill.description;

    result.push({ name, description: desc, skillName: entry.skill.name });
  }

  return result;
}
