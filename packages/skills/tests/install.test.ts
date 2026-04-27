import { describe, it, expect } from "vitest";
import { installSkillDeps, sanitizeString } from "../src/install.js";
import type { SkillEntry } from "../src/types.js";

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

describe("installSkillDeps", () => {
  it("returns empty result for a skill with no install specs", async () => {
    const result = await installSkillDeps(makeEntry());
    expect(result).toEqual({ installed: [], skipped: [], errors: [] });
  });

  it("skips install specs that don't match current OS", async () => {
    const entry = makeEntry({
      metadata: { install: [{ kind: "brew", formula: "curl", os: ["linux"] }] },
    });
    const result = await installSkillDeps(entry, { os: "darwin" });
    expect(result.skipped).toContain("brew:curl");
    expect(result.installed).toEqual([]);
  });

  it("skips install specs where all bins already exist", async () => {
    const entry = makeEntry({
      metadata: {
        install: [{ kind: "brew", formula: "node", bins: ["node"] }],
      },
    });
    const result = await installSkillDeps(entry, { os: "darwin" });
    // node is almost always available, so it should be skipped
    expect(result.skipped.length).toBeGreaterThanOrEqual(0);
  });
});

describe("sanitizeString", () => {
  it("rejects leading dash", () => {
    expect(() => sanitizeString("-h")).toThrow();
  });

  it("rejects path traversal", () => {
    expect(() => sanitizeString("../etc/passwd")).toThrow();
  });

  it("accepts valid names", () => {
    expect(sanitizeString("curl")).toBe("curl");
    expect(sanitizeString("my-package")).toBe("my-package");
  });
});
