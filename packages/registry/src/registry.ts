import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { glob } from 'glob';
import { SkillManifestSchema, type SkillManifest } from './manifest-schema.js';
import { RatingStore } from './rating.js';
import type { TaskType } from './rating-dimensions.js';

/**
 * Normalize frontmatter data from community skills so more of them pass
 * our Zod schema. Handles the most common incompatibilities:
 *
 * 1. Missing `name` → default to directory name
 * 2. Missing `description` → default to empty string
 * 3. `name` is a number → coerce to string
 * 4. `metadata` is a JSON string → parse to object
 * 5. `metadata.openclaw.env` is an object with {required,optional} arrays
 *    of {name,label} → convert to our array-of-strings format
 */
function normalizeSkillData(data: Record<string, unknown>, dirName: string): Record<string, unknown> {
  // Default name from directory
  if (!data.name || data.name == null) {
    data.name = dirName;
  }
  // Coerce numeric name to string
  if (typeof data.name === 'number') {
    data.name = String(data.name);
  }
  // Default description
  if (!data.description || data.description == null) {
    data.description = '';
  }
  // Coerce metadata string to object
  if (typeof data.metadata === 'string') {
    try {
      data.metadata = JSON.parse(data.metadata as string);
    } catch {
      data.metadata = {};
    }
  }
  // Normalize metadata.openclaw.env from community object format
  // { required: [{name, label}], optional: [{name, label}] } → ["NAME1", "NAME2"]
  if (data.metadata && typeof data.metadata === 'object') {
    const meta = data.metadata as Record<string, unknown>;
    if (meta.openclaw && typeof meta.openclaw === 'object') {
      const oc = meta.openclaw as Record<string, unknown>;
      if (oc.env && typeof oc.env === 'object' && !Array.isArray(oc.env)) {
        const envObj = oc.env as { required?: { name?: string }[]; optional?: { name?: string }[] };
        const names: string[] = [];
        for (const e of envObj.required ?? []) {
          if (e.name && typeof e.name === 'string') names.push(e.name);
        }
        for (const e of envObj.optional ?? []) {
          if (e.name && typeof e.name === 'string') names.push(e.name);
        }
        oc.env = names;
      }
    }
  }
  return data;
}

export interface LoadedSkill {
  manifest: SkillManifest;
  instructions: string;
  dirPath: string;
  rating: number;
  routingScore?: number;
}

export class SkillRegistry {
  private skills: Map<string, LoadedSkill> = new Map();
  private ratingStore: RatingStore;

  constructor(
    private skillsDir: string,
    ratingsPath: string,
  ) {
    this.ratingStore = new RatingStore(ratingsPath);
  }

  /**
   * Load additional skills from a second directory, merging into the existing registry.
   * Skills from `extraDir` take priority — they overwrite any same-named skill already loaded.
   */
  async loadFrom(extraDir: string): Promise<void> {
    const pattern = extraDir.replace(/\\/g, '/') + '/**/SKILL.md';
    const files = await glob(pattern);

    for (const file of files) {
      try {
        const raw = fs.readFileSync(file, 'utf-8');
        const { data, content } = matter(raw);
        const dirName = path.basename(path.dirname(file));
        const manifest = SkillManifestSchema.parse(normalizeSkillData(data, dirName));

        const persistedEntry = this.ratingStore.getAll()[manifest.name];
        if (persistedEntry !== undefined) {
          manifest.rating = persistedEntry.dimensions.quality;
          manifest.invocations = persistedEntry.invocations;
        }

        this.skills.set(manifest.name, {
          manifest,
          instructions: content.trim(),
          dirPath: path.dirname(file),
          rating: manifest.rating,
          routingScore: this.ratingStore.getRoutingScore(manifest.name),
        });
      } catch {
        // silently skip incompatible skills from extra dir
      }
    }
  }

  async load(): Promise<void> {
    // glob requires forward slashes on all platforms (including Windows)
    const pattern = this.skillsDir.replace(/\\/g, '/') + '/**/SKILL.md';
    const files = await glob(pattern);

    let failCount = 0;
    for (const file of files) {
      try {
        const raw = fs.readFileSync(file, 'utf-8');
        const { data, content } = matter(raw);
        const dirName = path.basename(path.dirname(file));
        const manifest = SkillManifestSchema.parse(normalizeSkillData(data, dirName));

        // Merge persisted rating and invocation count over manifest defaults
        const persistedEntry = this.ratingStore.getAll()[manifest.name];
        if (persistedEntry !== undefined) {
          manifest.rating = persistedEntry.dimensions.quality;
          manifest.invocations = persistedEntry.invocations;
        }

        this.skills.set(manifest.name, {
          manifest,
          instructions: content.trim(),
          dirPath: path.dirname(file),
          rating: manifest.rating,
          routingScore: this.ratingStore.getRoutingScore(manifest.name),
        });
      } catch {
        failCount++;
      }
    }

    if (failCount > 0) {
      const total = files.length;
      process.stderr.write(
        `[Registry] Loaded ${total - failCount}/${total} skills (${failCount} skipped — incompatible format)\n`
      );
    }
  }

  getAll(): LoadedSkill[] {
    return Array.from(this.skills.values()).filter((s) => s.manifest.enabled);
  }

  getByName(name: string): LoadedSkill | undefined {
    return this.skills.get(name);
  }

  search(query: string): LoadedSkill[] {
    const q = query.toLowerCase();
    return this.getAll().filter(
      (s) =>
        s.manifest.name.includes(q) ||
        s.manifest.description.toLowerCase().includes(q) ||
        s.manifest.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }

  recordInvocation(skillName: string): void {
    this.ratingStore.recordInvocation(skillName);
    const skill = this.skills.get(skillName);
    if (skill) {
      skill.manifest.invocations++;
    }
  }

  recordFeedback(
    skillName: string,
    positive: boolean,
    comment?: string,
    source: 'cli' | 'web' | 'openclaw' | 'hermes' | 'other' = 'other',
    taskType?: TaskType,
  ): void {
    this.ratingStore.recordFeedback(skillName, positive, comment, source, taskType);
    const skill = this.skills.get(skillName);
    if (skill) {
      const updatedRating = this.ratingStore.getRating(skillName);
      if (updatedRating !== undefined) {
        skill.rating = updatedRating;
        skill.manifest.rating = skill.rating;
      }
      skill.routingScore = this.ratingStore.getRoutingScore(skillName);
    }
  }

  recordInvocationMetrics(
    skillName: string,
    opts: { success: boolean; latencyMs: number; tokenUsage: number },
  ): void {
    this.ratingStore.recordInvocationMetrics(skillName, opts);
    const skill = this.skills.get(skillName);
    if (skill) {
      skill.manifest.invocations = this.ratingStore.getOrCreate(skillName).invocations;
      skill.routingScore = this.ratingStore.getRoutingScore(skillName);
    }
  }

  getRoutingScore(skillName: string, taskType: TaskType = 'one-shot'): number {
    return this.ratingStore.getRoutingScore(skillName, taskType);
  }

  /**
   * Read raw SKILL.md and script files for a skill, used by the export endpoint.
   */
  getSkillFiles(skillName: string): { skillMd: string; scripts: Record<string, string> } | undefined {
    const skill = this.skills.get(skillName);
    if (!skill) return undefined;

    const skillMd = fs.readFileSync(path.join(skill.dirPath, 'SKILL.md'), 'utf-8');
    const scripts: Record<string, string> = {};

    const scriptsDir = path.join(skill.dirPath, 'scripts');
    if (fs.existsSync(scriptsDir)) {
      for (const file of fs.readdirSync(scriptsDir)) {
        const filePath = path.join(scriptsDir, file);
        if (fs.statSync(filePath).isFile()) {
          scripts[file] = fs.readFileSync(filePath, 'utf-8');
        }
      }
    }

    return { skillMd, scripts };
  }

  getRatingStore(): RatingStore {
    return this.ratingStore;
  }
}
