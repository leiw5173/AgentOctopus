import { spawn, execSync } from "child_process";
import { platform } from "os";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SkillEntry, SkillInstallSpec, InstallResult } from "./types.js";

export interface InstallPreferences {
  preferBrew?: boolean;
  nodeManager?: "npm" | "pnpm" | "yarn" | "bun";
  os?: string;
}

export interface InstallAttempt {
  bin: string;
  spec: SkillInstallSpec;
  command: string;
  success: boolean;
  error?: string;
}

export interface MissingBinInstallResult {
  success: boolean;
  installed: string[];
  failed: InstallAttempt[];
  manualInstructions: string[];
}

/**
 * Sanitize a user-supplied string for use in shell commands.
 * Rejects dangerous inputs — leading dashes, path traversal sequences.
 */
export function sanitizeString(input: string): string {
  if (/^[-]/.test(input))
    throw new Error(`Invalid input: starts with dash: "${input}"`);
  if (/\\/.test(input) || input.includes(".."))
    throw new Error(`Invalid input: path traversal: "${input}"`);
  return input;
}

/**
 * Filter install specs by OS and missing bins.
 */
export function filterInstallSpecs(
  specs: SkillInstallSpec[],
  missing: string[],
  platformName: string,
): SkillInstallSpec[] {
  return specs.filter((spec) => {
    if (spec.os && spec.os.length > 0 && !spec.os.includes(platformName)) {
      return false;
    }
    if (spec.bins && spec.bins.length > 0) {
      const hasMissing = spec.bins.some((b) => missing.includes(b));
      if (!hasMissing) return false;
    }
    return true;
  });
}

/**
 * Generate a human-readable manual installation command for a spec.
 */
export function generateManualInstruction(spec: SkillInstallSpec): string {
  switch (spec.kind) {
    case "brew":
      return `brew install ${spec.formula ?? spec.package ?? "<formula>"}`;
    case "node":
      return `npm install -g ${spec.package ?? "<package>"}`;
    case "go":
      return `go install ${spec.module ?? "<module>"}`;
    case "uv":
      return `uv tool install ${spec.package ?? "<package>"}`;
    case "download":
      return `curl -L "${spec.url ?? "<url>"}" -o <file>`;
    default:
      return "";
  }
}

/**
 * Install missing binaries based on install specs.
 * Returns per-bin results and manual instructions for failures.
 */
export async function installMissingBins(
  specs: SkillInstallSpec[],
  missing: string[],
  platformName: string,
): Promise<MissingBinInstallResult> {
  const filtered = filterInstallSpecs(specs, missing, platformName);
  const installed: string[] = [];
  const failed: InstallAttempt[] = [];
  const manualInstructions: string[] = [];

  for (const spec of filtered) {
    const targetBins = spec.bins ?? missing;

    try {
      await dispatchInstall(spec);
      installed.push(...targetBins);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      for (const bin of targetBins) {
        failed.push({
          bin,
          spec,
          command: `${spec.kind} install`,
          success: false,
          error: errorMsg,
        });
      }
      manualInstructions.push(generateManualInstruction(spec));
    }
  }

  return {
    success: failed.length === 0 && installed.length > 0,
    installed,
    failed,
    manualInstructions,
  };
}

/**
 * Install dependencies declared in a skill entry's metadata.install specs.
 * Each spec is dispatched to the appropriate package manager.
 */
export async function installSkillDeps(
  entry: SkillEntry,
  prefs?: InstallPreferences,
): Promise<InstallResult> {
  const specs = entry.metadata.install ?? [];
  if (specs.length === 0) return { installed: [], skipped: [], errors: [] };

  const currentOs = prefs?.os ?? platform();
  const result: InstallResult = { installed: [], skipped: [], errors: [] };

  for (const spec of specs) {
    const label =
      spec.formula ?? spec.package ?? spec.module ?? spec.url ?? "unknown";

    try {
      // Skip if spec targets a different OS
      if (spec.os && spec.os.length > 0 && !spec.os.includes(currentOs)) {
        result.skipped.push(`${spec.kind}:${label}`);
        continue;
      }

      // Skip if all required binaries already exist
      if (spec.bins && spec.bins.length > 0) {
        const allPresent = spec.bins.every((b) => isBinAvailable(b));
        if (allPresent) {
          result.skipped.push(`${spec.kind}:${label}`);
          continue;
        }
      }

      await dispatchInstall(spec, prefs);
      result.installed.push(`${spec.kind}:${label}`);
    } catch (err) {
      result.errors.push(
        `${spec.kind}:${label} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}

// ── Internal dispatch ────────────────────────────────────────────

async function dispatchInstall(
  spec: SkillInstallSpec,
  prefs?: InstallPreferences,
): Promise<void> {
  switch (spec.kind) {
    case "brew": {
      if (!spec.formula) throw new Error("brew install requires formula");
      await spawnAsync("brew", ["install", sanitizeString(spec.formula)]);
      break;
    }
    case "node": {
      if (!spec.package) throw new Error("node install requires package");
      const mgr = prefs?.nodeManager ?? "npm";
      await spawnAsync(mgr, ["install", "-g", sanitizeString(spec.package)]);
      break;
    }
    case "go": {
      if (!spec.module) throw new Error("go install requires module");
      await spawnAsync("go", ["install", sanitizeString(spec.module)]);
      break;
    }
    case "uv": {
      if (!spec.package) throw new Error("uv install requires package");
      await spawnAsync("uv", [
        "tool",
        "install",
        sanitizeString(spec.package),
      ]);
      break;
    }
    case "download": {
      if (!spec.url) throw new Error("download install requires url");
      const url = sanitizeString(spec.url);
      const targetDir = spec.targetDir ?? path.join(os.homedir(), ".local", "bin");

      // Create target directory if needed
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      const tmpFile = path.join(os.tmpdir(), `ao-install-${Date.now()}`);
      const archiveExt = spec.archive ?? path.extname(url).replace(/^\./, "");
      const archiveFile = `${tmpFile}.${archiveExt || "bin"}`;

      // Download
      await spawnAsync("curl", ["-L", url, "-o", archiveFile]);

      if (spec.extract) {
        const extractDir = `${tmpFile}-extracted`;
        fs.mkdirSync(extractDir, { recursive: true });

        if (archiveExt === "tar.gz" || archiveExt === "tgz") {
          const strip = spec.stripComponents ?? 1;
          await spawnAsync("tar", ["-xzf", archiveFile, "-C", extractDir, `--strip-components=${strip}`]);
        } else if (archiveExt === "zip") {
          await spawnAsync("unzip", ["-o", archiveFile, "-d", extractDir]);
        } else {
          // Unknown archive — move as-is
          fs.renameSync(archiveFile, path.join(extractDir, path.basename(archiveFile)));
        }

        // Move all files from extract dir to targetDir
        const files = fs.readdirSync(extractDir);
        for (const file of files) {
          const src = path.join(extractDir, file);
          const dest = path.join(targetDir, file);
          fs.renameSync(src, dest);
          fs.chmodSync(dest, 0o755);
        }

        // Cleanup
        fs.rmSync(extractDir, { recursive: true, force: true });
        if (fs.existsSync(archiveFile)) fs.unlinkSync(archiveFile);
      } else {
        // Not an archive — move directly
        const destFile = path.join(targetDir, path.basename(archiveFile));
        fs.renameSync(archiveFile, destFile);
        fs.chmodSync(destFile, 0o755);
      }

      break;
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function spawnAsync(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "pipe", timeout: 120_000 });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`${cmd} ${args.join(" ")} exited with code ${code}`),
        );
    });
    child.on("error", reject);
  });
}

function isBinAvailable(bin: string): boolean {
  try {
    execSync(`command -v ${sanitizeString(bin)}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
