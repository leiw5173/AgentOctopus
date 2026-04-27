import { describe, it, expect } from "vitest";
import { resolveSkillConfig } from "../src/config.js";
import type { SkillsConfig } from "../src/types.js";

const baseConfig: SkillsConfig = {
  entries: {
    "weather": { enabled: true, apiKey: "key-123", env: { DEBUG: "1" } },
    "translation": { enabled: false },
    "no-config-skill": {},
  },
};

describe("resolveSkillConfig", () => {
  it("returns the config for a skill by skillKey", () => {
    const result = resolveSkillConfig(baseConfig, "weather");
    expect(result).toEqual({ enabled: true, apiKey: "key-123", env: { DEBUG: "1" } });
  });

  it("returns undefined for unknown skills", () => {
    const result = resolveSkillConfig(baseConfig, "unknown-skill");
    expect(result).toBeUndefined();
  });

  it("returns the config even when only partial", () => {
    const result = resolveSkillConfig(baseConfig, "no-config-skill");
    expect(result).toEqual({});
  });

  it("returns undefined when entries is absent", () => {
    const result = resolveSkillConfig({}, "weather");
    expect(result).toBeUndefined();
  });
});
