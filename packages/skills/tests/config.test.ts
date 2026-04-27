import { describe, it, expect } from "vitest";
import { resolveSkillConfig, shouldIncludeSkill, evaluateRuntimeEligibility } from "../src/config.js";
import type { SkillsConfig, SkillEntry, SkillEligibilityContext } from "../src/types.js";

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

function makeEntry(overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    skill: {
      name: "test-skill",
      description: "A test skill",
      version: "1.0.0",
      dirPath: "/tmp/test-skill",
      source: "bundled",
      tags: [],
      instructions: "",
      frontmatter: {},
    },
    frontmatter: {},
    metadata: {},
    invocation: { userInvocable: true, disableModelInvocation: false },
    ...overrides,
  };
}

const darwinCtx: SkillEligibilityContext = {
  hasBin: (b) => ["curl", "node", "python3"].includes(b),
  hasAnyBin: (bins) => bins.some(b => ["curl", "node", "python3"].includes(b)),
  hasEnv: (k) => k === "OPENWEATHER_API_KEY",
  isConfigPathTruthy: (p) => p === "browser.enabled",
  os: "darwin",
};

describe("shouldIncludeSkill", () => {
  it("includes a simple skill with no restrictions", () => {
    const entry = makeEntry();
    const result = shouldIncludeSkill({ entry, config: undefined, eligibility: darwinCtx });
    expect(result).toBe(true);
  });

  it("excludes a skill with enabled: false in config", () => {
    const entry = makeEntry({ metadata: { skillKey: "disabled-skill" } });
    const config = { entries: { "disabled-skill": { enabled: false } } };
    const result = shouldIncludeSkill({ entry, config, eligibility: darwinCtx });
    expect(result).toBe(false);
  });

  it("includes a skill with enabled: true in config", () => {
    const entry = makeEntry({ metadata: { skillKey: "enabled-skill" } });
    const config = { entries: { "enabled-skill": { enabled: true } } };
    const result = shouldIncludeSkill({ entry, config, eligibility: darwinCtx });
    expect(result).toBe(true);
  });
});

describe("evaluateRuntimeEligibility", () => {
  it("passes a skill with no runtime requirements", () => {
    expect(evaluateRuntimeEligibility(makeEntry(), darwinCtx)).toBe(true);
  });

  it("passes when always: true regardless of other gates", () => {
    const entry = makeEntry({ metadata: { always: true, os: ["linux"], requires: { bins: ["nonexistent"] } } });
    expect(evaluateRuntimeEligibility(entry, darwinCtx)).toBe(true);
  });

  it("excludes when OS does not match", () => {
    expect(evaluateRuntimeEligibility(makeEntry({ metadata: { os: ["linux", "windows"] } }), darwinCtx)).toBe(false);
  });

  it("passes when OS matches", () => {
    expect(evaluateRuntimeEligibility(makeEntry({ metadata: { os: ["darwin", "linux"] } }), darwinCtx)).toBe(true);
  });

  it("excludes when a required bin is missing", () => {
    expect(evaluateRuntimeEligibility(makeEntry({ metadata: { requires: { bins: ["nonexistent"] } } }), darwinCtx)).toBe(false);
  });

  it("passes when all required bins are present", () => {
    expect(evaluateRuntimeEligibility(makeEntry({ metadata: { requires: { bins: ["curl", "node"] } } }), darwinCtx)).toBe(true);
  });

  it("excludes when none of anyBins are present", () => {
    expect(evaluateRuntimeEligibility(makeEntry({ metadata: { requires: { anyBins: ["nonexistent1", "nonexistent2"] } } }), darwinCtx)).toBe(false);
  });

  it("passes when at least one anyBin is present", () => {
    expect(evaluateRuntimeEligibility(makeEntry({ metadata: { requires: { anyBins: ["python3", "nonexistent"] } } }), darwinCtx)).toBe(true);
  });

  it("excludes when a required env var is missing", () => {
    expect(evaluateRuntimeEligibility(makeEntry({ metadata: { requires: { env: ["MISSING_KEY"] } } }), darwinCtx)).toBe(false);
  });

  it("passes when all required env vars are set", () => {
    expect(evaluateRuntimeEligibility(makeEntry({ metadata: { requires: { env: ["OPENWEATHER_API_KEY"] } } }), darwinCtx)).toBe(true);
  });

  it("excludes when a required config path is falsy", () => {
    expect(evaluateRuntimeEligibility(makeEntry({ metadata: { requires: { config: ["browser.disabled"] } } }), darwinCtx)).toBe(false);
  });

  it("passes when all required config paths are truthy", () => {
    expect(evaluateRuntimeEligibility(makeEntry({ metadata: { requires: { config: ["browser.enabled"] } } }), darwinCtx)).toBe(true);
  });
});

describe("isBundledSkillAllowed", () => {
  function bundledEntry(overrides: Partial<SkillEntry> = {}): SkillEntry {
    return makeEntry({ skill: { ...makeEntry().skill, source: "bundled" }, ...overrides });
  }

  it("allows bundled skill when allowBundled is undefined", () => {
    const result = shouldIncludeSkill({ entry: bundledEntry(), config: {}, eligibility: darwinCtx });
    expect(result).toBe(true);
  });

  it("blocks bundled skill when allowBundled is empty array", () => {
    const config = { allowBundled: [] };
    const result = shouldIncludeSkill({ entry: bundledEntry(), config, eligibility: darwinCtx });
    expect(result).toBe(false);
  });

  it("allows bundled skill in allowBundled list by name", () => {
    const config = { allowBundled: ["test-skill"] };
    const result = shouldIncludeSkill({ entry: bundledEntry(), config, eligibility: darwinCtx });
    expect(result).toBe(true);
  });

  it("allows bundled skill in allowBundled list by skillKey", () => {
    const config = { allowBundled: ["my-key"] };
    const result = shouldIncludeSkill({ entry: bundledEntry({ metadata: { skillKey: "my-key" } }), config, eligibility: darwinCtx });
    expect(result).toBe(true);
  });

  it("blocks bundled skill not in allowBundled", () => {
    const config = { allowBundled: ["other-skill"] };
    const result = shouldIncludeSkill({ entry: bundledEntry(), config, eligibility: darwinCtx });
    expect(result).toBe(false);
  });

  it("does NOT block non-bundled skills even with allowBundled", () => {
    const entry = makeEntry({ skill: { ...makeEntry().skill, source: "user" } });
    const config = { allowBundled: ["other-skill"] };
    const result = shouldIncludeSkill({ entry, config, eligibility: darwinCtx });
    expect(result).toBe(true);
  });
});
