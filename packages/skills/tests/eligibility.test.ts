import { describe, it, expect } from "vitest";
import { shouldIncludeSkill, evaluateRuntimeEligibility } from "../src/config.js";
import type { SkillEntry, SkillEligibilityContext } from "../src/types.js";

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

function makeCtx(os: string): SkillEligibilityContext {
  return {
    hasBin: () => false,
    hasAnyBin: () => false,
    hasEnv: () => false,
    isConfigPathTruthy: () => false,
    os,
  };
}

describe("windows os eligibility", () => {
  // Regression guard: the router passes 'windows' (normalized from process.platform 'win32')
  // — see packages/core/src/router.ts. A skill declaring os: ['windows'] must be eligible
  // on Windows and excluded everywhere else (fail-closed).

  it("includes a skill with os: ['windows'] on platform windows", () => {
    const entry = makeEntry({ metadata: { os: ["windows"] } });
    expect(shouldIncludeSkill({ entry, config: undefined, eligibility: makeCtx("windows") })).toBe(true);
  });

  it("excludes a skill with os: ['windows'] on platform linux", () => {
    const entry = makeEntry({ metadata: { os: ["windows"] } });
    expect(shouldIncludeSkill({ entry, config: undefined, eligibility: makeCtx("linux") })).toBe(false);
  });

  it("excludes a skill with os: ['windows'] on platform darwin", () => {
    const entry = makeEntry({ metadata: { os: ["windows"] } });
    expect(shouldIncludeSkill({ entry, config: undefined, eligibility: makeCtx("darwin") })).toBe(false);
  });

  it("excludes a skill with os: ['windows'] on platform macos (router alias)", () => {
    const entry = makeEntry({ metadata: { os: ["windows"] } });
    expect(shouldIncludeSkill({ entry, config: undefined, eligibility: makeCtx("macos") })).toBe(false);
  });

  it("includes a skill with os: ['linux', 'windows'] on platform windows", () => {
    const entry = makeEntry({ metadata: { os: ["linux", "windows"] } });
    expect(shouldIncludeSkill({ entry, config: undefined, eligibility: makeCtx("windows") })).toBe(true);
  });

  it("always: true bypasses the os gate on every platform", () => {
    const entry = makeEntry({ metadata: { always: true, os: ["windows"] } });
    expect(evaluateRuntimeEligibility(entry, makeCtx("windows"))).toBe(true);
    expect(evaluateRuntimeEligibility(entry, makeCtx("linux"))).toBe(true);
    expect(evaluateRuntimeEligibility(entry, makeCtx("darwin"))).toBe(true);
  });

  it("always: true bypasses all gates via shouldIncludeSkill too", () => {
    const entry = makeEntry({
      metadata: { always: true, os: ["windows"], requires: { bins: ["nonexistent"] } },
    });
    expect(shouldIncludeSkill({ entry, config: undefined, eligibility: makeCtx("linux") })).toBe(true);
  });
});
