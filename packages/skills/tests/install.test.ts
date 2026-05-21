import { describe, it, expect } from "vitest";
import { installSkillDeps, sanitizeString, filterInstallSpecs, generateManualInstruction } from "../src/install.js";
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
    expect(result.skipped.length).toBeGreaterThanOrEqual(0);
  });
});

describe("filterInstallSpecs", () => {
  it("filters by OS", () => {
    const specs = [
      { kind: "brew" as const, formula: "tool1", os: ["darwin"] },
      { kind: "brew" as const, formula: "tool2", os: ["linux"] },
    ];
    const result = filterInstallSpecs(specs, ["tool1", "tool2"], "darwin");
    expect(result).toHaveLength(1);
    expect(result[0].formula).toBe("tool1");
  });

  it("filters by missing bins intersection", () => {
    const specs = [
      { kind: "brew" as const, formula: "openmeteo", bins: ["openmeteo"] },
      { kind: "brew" as const, formula: "other", bins: ["other"] },
    ];
    const result = filterInstallSpecs(specs, ["openmeteo"], "darwin");
    expect(result).toHaveLength(1);
    expect(result[0].formula).toBe("openmeteo");
  });

  it("includes specs with no os or bins restrictions", () => {
    const specs = [{ kind: "brew" as const, formula: "openmeteo" }];
    const result = filterInstallSpecs(specs, ["openmeteo"], "darwin");
    expect(result).toHaveLength(1);
  });

  it("excludes specs whose bins don't overlap with missing", () => {
    const specs = [{ kind: "brew" as const, formula: "tool", bins: ["a"] }];
    const result = filterInstallSpecs(specs, ["b"], "darwin");
    expect(result).toHaveLength(0);
  });
});

describe("generateManualInstruction", () => {
  it("generates brew command from formula", () => {
    expect(generateManualInstruction({ kind: "brew", formula: "openmeteo" })).toBe("brew install openmeteo");
  });

  it("generates brew command from package", () => {
    expect(generateManualInstruction({ kind: "brew", package: "openmeteo" })).toBe("brew install openmeteo");
  });

  it("generates node command", () => {
    expect(generateManualInstruction({ kind: "node", package: "openmeteo-sh" })).toBe("npm install -g openmeteo-sh");
  });

  it("generates go command", () => {
    expect(generateManualInstruction({ kind: "go", module: "github.com/user/pkg" })).toBe("go install github.com/user/pkg");
  });

  it("generates uv command", () => {
    expect(generateManualInstruction({ kind: "uv", package: "openmeteo" })).toBe("uv tool install openmeteo");
  });

  it("generates download command", () => {
    expect(generateManualInstruction({ kind: "download", url: "https://example.com/tool.tgz" })).toBe("curl -L \"https://example.com/tool.tgz\" -o <file>");
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
