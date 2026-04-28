import { describe, it, expect } from "vitest";
import { parseSkillFrontmatter } from "../src/frontmatter.js";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import matter from "gray-matter";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");

describe("parseSkillFrontmatter", () => {
  it("resolves flat fields when they are present", () => {
    const raw = readFileSync(resolve(fixturesDir, "mixed-format/SKILL.md"), "utf8");
    const { data } = matter(raw);
    const result = parseSkillFrontmatter(data);
    // Flat wins over openclaw for os
    expect(result.metadata.os).toEqual(["darwin"]);
    // Flat wins for primaryEnv
    expect(result.metadata.primaryEnv).toBe("TOP_LEVEL_KEY");
    // Flat wins for requires.bins
    expect(result.metadata.requires?.bins).toEqual(["curl"]);
  });

  it("falls back to openclaw block fields when flat is absent", () => {
    const raw = readFileSync(resolve(fixturesDir, "openclaw-format/SKILL.md"), "utf8");
    const { data } = matter(raw);
    const result = parseSkillFrontmatter(data);
    // openclaw.os is used since top-level os is absent
    expect(result.metadata.os).toEqual(["darwin", "linux"]);
    // openclaw.primaryEnv is used
    expect(result.metadata.primaryEnv).toBe("OPENWEATHER_API_KEY");
    // openclaw.skillKey is used
    expect(result.metadata.skillKey).toBe("weather-v2");
  });

  it("parses invocation policy with defaults", () => {
    const result = parseSkillFrontmatter({
      name: "test",
      description: "test skill",
    });
    expect(result.invocation.userInvocable).toBe(true);
    expect(result.invocation.disableModelInvocation).toBe(false);
  });

  it("parses explicit invocation policy", () => {
    const result = parseSkillFrontmatter({
      name: "test",
      description: "test skill",
      "user-invocable": false,
      "disable-model-invocation": true,
    });
    expect(result.invocation.userInvocable).toBe(false);
    expect(result.invocation.disableModelInvocation).toBe(true);
  });

  it("uses flat install when present (flat wins entirely over openclaw install)", () => {
    const result = parseSkillFrontmatter({
      name: "test",
      description: "test skill",
      install: [{ kind: "brew", formula: "curl" }],
      openclaw: {
        install: [{ kind: "go", module: "example.com/cmd" }],
      },
    });
    // Flat install wins entirely (not merged per-entry)
    expect(result.metadata.install).toEqual([{ kind: "brew", formula: "curl" }]);
  });

  it("uses openclaw install when flat install is absent", () => {
    const result = parseSkillFrontmatter({
      name: "test",
      description: "test skill",
      openclaw: {
        install: [{ kind: "go", module: "example.com/cmd" }],
      },
    });
    expect(result.metadata.install).toEqual([{ kind: "go", module: "example.com/cmd" }]);
  });
});
