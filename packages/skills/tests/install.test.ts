import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as install from "../src/install.js";
import { sanitizeString, generateManualInstruction } from "../src/install.js";

const INSTALL_SRC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "install.ts",
);

describe("host binary installation is removed", () => {
  it("does not export installMissingBins", () => {
    expect("installMissingBins" in install).toBe(false);
  });

  it("does not export installSkillDeps", () => {
    expect("installSkillDeps" in install).toBe(false);
  });

  it("does not export filterInstallSpecs", () => {
    expect("filterInstallSpecs" in install).toBe(false);
  });

  it("source contains no child_process / execSync / spawn host execution", () => {
    const src = fs.readFileSync(INSTALL_SRC, "utf8");
    expect(src).not.toMatch(/child_process|execSync|\bspawn\(/);
  });
});

describe("generateManualInstruction (operator-facing text only)", () => {
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
