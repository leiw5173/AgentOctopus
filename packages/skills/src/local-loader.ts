import { glob } from "glob";
import { readFileSync } from "fs";
import { dirname } from "path";
import matter from "gray-matter";
import { SkillFrontmatterSchema } from "./schema.js";
import type { SkillMetadata } from "./types.js";
import { parseSkillFrontmatter } from "./frontmatter.js";
import type { SkillEntry, Skill, SkillSource } from "./types.js";

/**
 * Load all SKILL.md files from a directory. Each skill is a directory
 * containing a SKILL.md file. Returns parsed SkillEntry array.
 * Non-existent dir returns empty array. Invalid SKILL.md files are
 * logged at debug level and skipped.
 */
export async function loadSkillsFromDir(
  dirPath: string,
  source: SkillSource,
  opts?: { maxCandidates?: number },
): Promise<SkillEntry[]> {
  const max = opts?.maxCandidates ?? 300;
  try {
    const files = await glob("**/SKILL.md", {
      cwd: dirPath,
      absolute: true,
      nodir: true,
      ignore: ["node_modules/**", ".git/**"],
    });
    const selected = files.slice(0, max);

    const entries: SkillEntry[] = [];
    for (const file of selected) {
      try {
        const raw = readFileSync(file, "utf8");
        const parsed = matter(raw);
        const frontmatter = SkillFrontmatterSchema.parse(parsed.data);

        // Extract install specs from raw data (nested under metadata.openclaw)
        // and requires from Zod-validated frontmatter for proper schema enforcement
        const rawMeta = parsed.data.metadata as Record<string, unknown> | undefined;
        const openclaw = (rawMeta?.openclaw ?? parsed.data.openclaw ?? {}) as Record<string, unknown>;
        const rawInstall = (rawMeta?.install ?? parsed.data.install ?? openclaw.install) as SkillMetadata['install'];

        const { metadata, invocation } = parseSkillFrontmatter(
          frontmatter as Record<string, unknown>,
        );

        // Merge install specs from raw data (parsed.data has metadata.openclaw.install
        // which Zod strips because it's nested, not top-level)
        if (rawInstall && Array.isArray(rawInstall)) {
          metadata.install = rawInstall;
        }

        // Use tags from raw frontmatter (schema may strip them)
        const rawTags = parsed.data.tags;
        const tags = Array.isArray(rawTags)
          ? rawTags.map(String)
          : typeof rawTags === 'string'
            ? [rawTags]
            : [];

        const skillDir = dirname(file);
        const skill: Skill = {
          name: frontmatter.name,
          description: frontmatter.description,
          version: frontmatter.version ?? "0.0.0",
          dirPath: skillDir,
          source,
          tags,
          instructions: (parsed.content ?? "").trim(),
          frontmatter: frontmatter as Record<string, unknown>,
        };

        entries.push({
          skill,
          frontmatter: frontmatter as Record<string, unknown>,
          metadata,
          invocation,
        });
      } catch {
        // Skip invalid SKILL.md files — they're logged at debug level in production
      }
    }
    return entries;
  } catch {
    return [];
  }
}
