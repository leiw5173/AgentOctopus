import { describe, it, expect } from "vitest";
import { loadSkillsFromDir } from "../src/local-loader.js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");

describe("loadSkillsFromDir", () => {
  it("loads all SKILL.md files from a directory", async () => {
    const skills = await loadSkillsFromDir(fixturesDir, "test");
    expect(skills.length).toBeGreaterThanOrEqual(5);
    const names = skills.map(s => s.skill.name).sort();
    expect(names).toContain("minimal-skill");
    expect(names).toContain("scripts-only");
  });

  it("sets the source label on loaded skills", async () => {
    const skills = await loadSkillsFromDir(fixturesDir, "bundled");
    for (const entry of skills) {
      expect(entry.skill.source).toBe("bundled");
    }
  });

  it("returns empty array for nonexistent directory", async () => {
    const skills = await loadSkillsFromDir("/tmp/nonexistent-dir-12345", "test");
    expect(skills).toEqual([]);
  });

  it("parses SKILL.md frontmatter into metadata", async () => {
    const skills = await loadSkillsFromDir(fixturesDir, "test");
    const minimal = skills.find(s => s.skill.name === "minimal-skill");
    expect(minimal).toBeDefined();
    expect(minimal!.skill.description).toBe("A minimal test skill");
    expect(minimal!.metadata).toBeDefined();
    expect(minimal!.invocation.userInvocable).toBe(true);
  });

  it("reads instructions (body after frontmatter) from SKILL.md", async () => {
    const skills = await loadSkillsFromDir(fixturesDir, "test");
    const minimal = skills.find(s => s.skill.name === "minimal-skill");
    expect(minimal).toBeDefined();
    expect(minimal!.skill.instructions).toContain("No special features");
  });
});
