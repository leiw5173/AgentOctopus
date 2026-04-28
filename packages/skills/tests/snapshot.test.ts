import { describe, it, expect } from "vitest";
import { buildWorkspaceSkillSnapshot } from "../src/snapshot.js";
import type { SkillEntry } from "../src/types.js";

function makeEntry(name: string, overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    skill: { name, description: `The ${name} skill`, version: "1.0.0", dirPath: `/tmp/${name}`, source: "bundled", tags: [], instructions: "", frontmatter: {} },
    frontmatter: {},
    metadata: {},
    invocation: { userInvocable: true, disableModelInvocation: false },
    exposure: { includeInRuntimeRegistry: true, includeInAvailableSkillsPrompt: true, userInvocable: true },
    ...overrides,
  };
}

describe("buildWorkspaceSkillSnapshot", () => {
  it("builds a snapshot with prompt XML for eligible skills", () => {
    const entries = [
      makeEntry("weather", { metadata: { primaryEnv: "WEATHER_KEY" } }),
      makeEntry("translation"),
    ];
    const snapshot = buildWorkspaceSkillSnapshot(entries);
    expect(snapshot.prompt).toContain("<available_skills>");
    expect(snapshot.prompt).toContain("<name>weather</name>");
    expect(snapshot.prompt).toContain("<name>translation</name>");
    expect(snapshot.skills).toHaveLength(2);
    expect(snapshot.version).toBeGreaterThan(0);
  });

  it("excludes skills with disableModelInvocation from prompt", () => {
    const entries = [
      makeEntry("visible"),
      makeEntry("hidden", {
        invocation: { userInvocable: true, disableModelInvocation: true },
        exposure: { includeInRuntimeRegistry: true, includeInAvailableSkillsPrompt: false, userInvocable: true },
      }),
    ];
    const snapshot = buildWorkspaceSkillSnapshot(entries);
    expect(snapshot.prompt).toContain("visible");
    expect(snapshot.prompt).not.toContain("hidden");
    expect(snapshot.skills).toHaveLength(1);
  });

  it("includes primaryEnv and requiredEnv in skills array", () => {
    const entries = [
      makeEntry("weather", {
        metadata: { primaryEnv: "WEATHER_KEY", requires: { env: ["WEATHER_KEY", "DEBUG"] } },
      }),
    ];
    const snapshot = buildWorkspaceSkillSnapshot(entries);
    expect(snapshot.skills[0].primaryEnv).toBe("WEATHER_KEY");
    expect(snapshot.skills[0].requiredEnv).toEqual(["WEATHER_KEY", "DEBUG"]);
  });

  it("falls back to compact format when full prompt exceeds char budget", () => {
    const entries = Array.from({ length: 200 }, (_, i) =>
      makeEntry(`skill-${i}`, {
        skill: {
          ...makeEntry(`skill-${i}`).skill,
          description: "A".repeat(200),
          dirPath: `/very/long/path/that/takes/many/chars/${i}/SKILL.md`,
        },
      }),
    );
    const snapshot = buildWorkspaceSkillSnapshot(entries, { maxSkillsPromptChars: 500 });
    expect(snapshot.prompt.length).toBeLessThanOrEqual(600);
  });
});
