import { spawn, execSync } from "child_process";
import { platform } from "os";
import type { SkillEntry, SkillInstallSpec, InstallResult } from "./types.js";

export interface InstallPreferences {
  preferBrew?: boolean;
  nodeManager?: "npm" | "pnpm" | "yarn" | "bun";
  os?: string;
}

/**
 * Sanitize a user-supplied string for use in shell commands.
 * Rejects dangerous inputs — leading dashes, path traversal sequences.
 */
export function sanitizeString(input: string): string {
  if (/^[-]/.test(input))
    throw new Error(`Invalid input: starts with dash: "${input}"`);
  if (/\\\\/.test(input) || input.includes(".."))
    throw new Error(`Invalid input: path traversal: "${input}"`);
  return input;
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
    case "download":
      throw new Error(
        "download install not yet implemented (use ClawHub for ZIP downloads)",
      );
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
