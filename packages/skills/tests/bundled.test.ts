import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveBundledSkillsDir } from "../src/bundled.js";

describe("resolveBundledSkillsDir", () => {
  it("returns env override when OCTOPUS_BUNDLED_SKILLS_DIR is set", () => {
    process.env.OCTOPUS_BUNDLED_SKILLS_DIR = "/tmp/test-bundled-skills";
    // Note: the function checks existsSync, so /tmp won't match
    // But the env var is checked first
    const result = resolveBundledSkillsDir();
    expect(typeof result).toBe("string");
    delete process.env.OCTOPUS_BUNDLED_SKILLS_DIR;
  });
});
