import { describe, it, expect } from "vitest";
import { loadWorkspaceSkills, mergeByPriority } from "../src/workspace.js";
import { loadSkillsFromDir } from "../src/local-loader.js";
import type { SkillEligibilityContext } from "../src/types.js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");

const passthroughCtx: SkillEligibilityContext = {
  hasBin: () => true,
  hasAnyBin: () => true,
  hasEnv: () => true,
  isConfigPathTruthy: () => true,
  os: "darwin",
};

describe("mergeByPriority", () => {
  it("returns empty array for no sources", () => {
    expect(mergeByPriority([])).toEqual([]);
  });

  it("merges a single source and deduplicates by name", async () => {
    const skills = await loadSkillsFromDir(fixturesDir, "bundled");
    const result = mergeByPriority([skills]);
    // Three fixtures share name "weather", so result has fewer entries than raw load
    const uniqueNames = new Set(skills.map(s => s.skill.name));
    expect(result.length).toBe(uniqueNames.size);
  });

  it("higher-priority source overwrites lower by name", async () => {
    const bundled = await loadSkillsFromDir(fixturesDir, "bundled");
    const user = await loadSkillsFromDir(fixturesDir, "user");
    const result = mergeByPriority([bundled, user]);
    const names = result.map(s => s.skill.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });
});

describe("loadWorkspaceSkills", () => {
  it("loads and filters skills from multiple sources", async () => {
    const sources = [{ dirPath: fixturesDir, source: "bundled" as const }];
    const entries = await loadWorkspaceSkills(sources, {
      config: undefined,
      eligibility: passthroughCtx,
    });
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.exposure).toBeDefined();
      expect(entry.exposure!.includeInRuntimeRegistry).toBe(true);
    }
  });

  it("filters out skills that fail eligibility", async () => {
    const sources = [{ dirPath: fixturesDir, source: "bundled" as const }];
    const strictCtx: SkillEligibilityContext = {
      hasBin: () => false,
      hasAnyBin: () => false,
      hasEnv: () => false,
      isConfigPathTruthy: () => false,
      os: "darwin",
    };
    const entries = await loadWorkspaceSkills(sources, {
      config: undefined,
      eligibility: strictCtx,
    });
    const heavy = entries.find(e => e.skill.name === "install-heavy");
    expect(heavy).toBeUndefined();
  });

  it("sets exposure correctly for model-visible skills", async () => {
    const sources = [{ dirPath: fixturesDir, source: "bundled" as const }];
    const entries = await loadWorkspaceSkills(sources, {
      config: undefined,
      eligibility: passthroughCtx,
    });
    for (const entry of entries) {
      if (!entry.invocation.disableModelInvocation) {
        expect(entry.exposure!.includeInAvailableSkillsPrompt).toBe(true);
      }
    }
  });
});
