import { describe, it, expect } from "vitest";
import { SkillFrontmatterSchema } from "../src/schema.js";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import matter from "gray-matter";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");

describe("SkillFrontmatterSchema", () => {
  it("parses a valid flat-format SKILL.md frontmatter", () => {
    const raw = readFileSync(resolve(fixturesDir, "valid-skill/SKILL.md"), "utf8");
    const parsed = matter(raw);
    const result = SkillFrontmatterSchema.parse(parsed.data);
    expect(result.name).toBe("weather");
    expect(result.os).toEqual(["darwin", "linux"]);
    expect(result.requires).toEqual({
      bins: ["curl"],
      anyBins: ["python3", "python"],
      env: ["OPENWEATHER_API_KEY"],
    });
  });

  it("parses an openclaw-block format SKILL.md frontmatter", () => {
    const raw = readFileSync(resolve(fixturesDir, "openclaw-format/SKILL.md"), "utf8");
    const parsed = matter(raw);
    const result = SkillFrontmatterSchema.parse(parsed.data);
    expect(result.name).toBe("weather");
    expect(result.os).toBeUndefined(); // os is inside openclaw, not at top level
  });

  it("rejects a SKILL.md with no name", () => {
    const result = SkillFrontmatterSchema.safeParse({ description: "no name" });
    expect(result.success).toBe(false);
  });

  it("rejects a SKILL.md with no description", () => {
    const result = SkillFrontmatterSchema.safeParse({ name: "test" });
    expect(result.success).toBe(false);
  });

  it("allows unknown fields via passthrough", () => {
    const result = SkillFrontmatterSchema.safeParse({
      name: "test",
      description: "a test skill",
      someRandomField: "value",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an untrusted sandbox.request block (requests only)", () => {
    const result = SkillFrontmatterSchema.safeParse({
      name: "weather",
      description: "Weather skill",
      sandbox: {
        hosts: ["wttr.in"],
        credentials: ["WTR_API_KEY"],
        resources: { memory: "256m", timeoutMs: 20000 },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sandbox?.hosts).toEqual(["wttr.in"]);
      expect(result.data.sandbox?.credentials).toEqual(["WTR_API_KEY"]);
    }
  });

  it("rejects trusted/grant keys in the untrusted sandbox manifest block", () => {
    const base = { name: "x", description: "x" };
    // Manifest must NOT be able to grant itself anything or override backends.
    for (const bad of [
      { sandbox: { grants: [] } },
      { sandbox: { defaultBackend: "docker" } },
      { sandbox: { minIsolationLevel: "none" } },
      { sandbox: { docker: {} } },
      { sandbox: { proxy: {} } },
      { sandbox: { runtimeProfiles: {} } },
      { sandbox: { backend: "docker" } },
      { sandbox: { image: "alpine" } },
      { sandbox: { credentials: [{ key: "K", host: "x" }] } },
    ]) {
      expect(SkillFrontmatterSchema.safeParse({ ...base, ...bad }).success).toBe(false);
    }
  });
});
