import { describe, it, expect } from "vitest";
import { buildWorkspaceSkillCommandSpecs } from "../src/command-specs.js";
import type { SkillEntry } from "../src/types.js";

function makeEntry(name: string, overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    skill: {
      name, description: `The ${name} skill`, version: "1.0.0",
      dirPath: `/tmp/${name}`, source: "bundled", tags: [], instructions: "", frontmatter: {},
    },
    frontmatter: {},
    metadata: {},
    invocation: { userInvocable: true, disableModelInvocation: false },
    ...overrides,
  };
}

describe("buildWorkspaceSkillCommandSpecs", () => {
  it("returns specs for user-invocable skills", () => {
    const specs = buildWorkspaceSkillCommandSpecs([makeEntry("weather"), makeEntry("translation")]);
    expect(specs.length).toBe(2);
    expect(specs[0].name).toBe("weather");
    expect(specs[0].skillName).toBe("weather");
  });

  it("excludes non-user-invocable skills", () => {
    const specs = buildWorkspaceSkillCommandSpecs([
      makeEntry("weather"),
      makeEntry("hidden", { invocation: { userInvocable: false, disableModelInvocation: true } }),
    ]);
    expect(specs.length).toBe(1);
    expect(specs[0].name).toBe("weather");
  });

  it("sanitizes names to lowercase + underscores, max 32 chars", () => {
    const specs = buildWorkspaceSkillCommandSpecs([makeEntry("My-Cool Skill!")]);
    expect(specs[0].name).toMatch(/^[a-z0-9_]+$/);
    expect(specs[0].name.length).toBeLessThanOrEqual(32);
  });

  it("deduplicates name collisions with _2 suffix", () => {
    const specs = buildWorkspaceSkillCommandSpecs([makeEntry("my-skill"), makeEntry("my_skill")]);
    expect(specs.length).toBe(2);
    expect(specs.some(s => s.name.endsWith("_2"))).toBe(true);
  });

  it("truncates descriptions to 100 chars", () => {
    const entry = makeEntry("weather");
    entry.skill.description = "A".repeat(200);
    const specs = buildWorkspaceSkillCommandSpecs([entry]);
    expect(specs[0].description.length).toBeLessThanOrEqual(100);
  });
});
