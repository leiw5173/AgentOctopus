import { existsSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

export function resolveBundledSkillsDir(): string | null {
  const envDir = process.env.OCTOPUS_BUNDLED_SKILLS_DIR;
  if (envDir && existsSync(envDir)) return envDir;

  const devPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bundled");
  if (existsSync(devPath)) return devPath;

  const distPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "bundled");
  if (existsSync(distPath)) return distPath;

  let current = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(current, "bundled");
    try {
      if (existsSync(candidate) && hasSkillFiles(candidate)) return candidate;
    } catch { /* continue */ }
    current = resolve(current, "..");
  }

  return null;
}

function hasSkillFiles(dir: string): boolean {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries.some(e => e.isDirectory() || (e.isFile() && e.name.endsWith(".md")));
  } catch {
    return false;
  }
}
