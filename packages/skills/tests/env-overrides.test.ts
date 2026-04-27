import { describe, it, expect, afterEach } from "vitest";
import { applySkillEnvOverrides } from "../src/env-overrides.js";
import type { SkillEntry, SkillsConfig } from "../src/types.js";

function makeEntry(name: string, overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    skill: { name, description: name, version: "1.0.0", dirPath: `/tmp/${name}`, source: "bundled", tags: [], instructions: "", frontmatter: {} },
    frontmatter: {},
    metadata: {},
    invocation: { userInvocable: true, disableModelInvocation: false },
    ...overrides,
  };
}

describe("applySkillEnvOverrides", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in origEnv)) delete process.env[key];
    }
    for (const [key, val] of Object.entries(origEnv)) {
      if (val !== undefined) process.env[key] = val;
    }
  });

  it("returns a no-op reverter for skills with no env config", () => {
    const revert = applySkillEnvOverrides([makeEntry("test")], {});
    expect(typeof revert).toBe("function");
    revert();
  });

  it("injects apiKey into primaryEnv variable", () => {
    const entry = makeEntry("weather", { metadata: { primaryEnv: "WEATHER_KEY", skillKey: "weather" } });
    const config: SkillsConfig = { entries: { weather: { apiKey: "abc123" } } };
    const revert = applySkillEnvOverrides([entry], config);
    expect(process.env.WEATHER_KEY).toBe("abc123");
    revert();
    expect(process.env.WEATHER_KEY).toBeUndefined();
  });

  it("injects per-skill env vars from config", () => {
    const entry = makeEntry("weather", { metadata: { skillKey: "weather" } });
    const config: SkillsConfig = { entries: { weather: { env: { DEBUG: "1" } } } };
    const revert = applySkillEnvOverrides([entry], config);
    expect(process.env.DEBUG).toBe("1");
    revert();
    expect(process.env.DEBUG).toBeUndefined();
  });

  it("blocks dangerous keys like OPENSSL_CONF", () => {
    const entry = makeEntry("weather", { metadata: { skillKey: "weather" } });
    const config: SkillsConfig = { entries: { weather: { env: { OPENSSL_CONF: "/evil/path" } } } };
    const revert = applySkillEnvOverrides([entry], config);
    expect(process.env.OPENSSL_CONF).not.toBe("/evil/path");
    revert();
  });
});
