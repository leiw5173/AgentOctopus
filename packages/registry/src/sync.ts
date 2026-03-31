/**
 * Cloud-to-local skill synchronization.
 *
 * Fetches the full skill export from a cloud AgentOctopus instance and
 * writes SKILL.md + scripts to the local registry directory.
 */

import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

export interface SkillExportEntry {
  name: string;
  version: string;
  skillMd: string;
  scripts: Record<string, string>;
}

export interface SkillExportResponse {
  skills: SkillExportEntry[];
  exportedAt: string;
}

export interface SyncResult {
  added: string[];
  updated: string[];
  skipped: string[];
  errors: string[];
}

/**
 * Sync skills from a cloud AgentOctopus instance into the local skills directory.
 *
 * By default, existing skills are skipped unless the remote version is newer
 * or `force` is true.
 */
export async function syncFromCloud(
  cloudUrl: string,
  skillsDir: string,
  force = false,
): Promise<SyncResult> {
  const exportUrl = cloudUrl.replace(/\/+$/, '') + '/agent/skills/export';
  const res = await fetch(exportUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch skill export from ${exportUrl}: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as SkillExportResponse;
  const result: SyncResult = { added: [], updated: [], skipped: [], errors: [] };

  for (const entry of data.skills) {
    try {
      const skillDir = path.join(skillsDir, entry.name);
      const skillMdPath = path.join(skillDir, 'SKILL.md');

      // Check if the skill already exists locally
      if (fs.existsSync(skillMdPath)) {
        if (!force) {
          // Compare versions — skip if local is same or newer
          const localRaw = fs.readFileSync(skillMdPath, 'utf-8');
          const { data: localData } = matter(localRaw);
          const localVersion = (localData.version as string) ?? '0.0.0';
          if (localVersion >= entry.version) {
            result.skipped.push(entry.name);
            continue;
          }
        }
        result.updated.push(entry.name);
      } else {
        result.added.push(entry.name);
      }

      // Write SKILL.md
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(skillMdPath, entry.skillMd, 'utf-8');

      // Write script files
      if (entry.scripts && Object.keys(entry.scripts).length > 0) {
        const scriptsDir = path.join(skillDir, 'scripts');
        fs.mkdirSync(scriptsDir, { recursive: true });
        for (const [filename, content] of Object.entries(entry.scripts)) {
          fs.writeFileSync(path.join(scriptsDir, filename), content, 'utf-8');
        }
      }
    } catch (err) {
      result.errors.push(`${entry.name}: ${(err as Error).message}`);
    }
  }

  return result;
}
