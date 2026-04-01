import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { glob } from 'glob';
import { SkillManifestSchema, type SkillManifest } from './manifest-schema.js';
import { RatingStore } from './rating.js';

export interface LoadedSkill {
  manifest: SkillManifest;
  instructions: string;
  dirPath: string;
  rating: number;
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

  async load(): Promise<void> {
    const pattern = path.join(this.skillsDir, '**', 'SKILL.md');
    const files = await glob(pattern);

    for (const file of files) {
      try {
        const raw = fs.readFileSync(file, 'utf-8');
        const { data, content } = matter(raw);
        const manifest = SkillManifestSchema.parse(data);

        // Merge persisted rating and invocation count over manifest defaults
        const persistedEntry = this.ratingStore.getAll()[manifest.name];
        if (persistedEntry !== undefined) {
          manifest.rating = persistedEntry.rating;
          manifest.invocations = persistedEntry.invocations;
        }

        this.skills.set(manifest.name, {
          manifest,
          instructions: content.trim(),
          dirPath: path.dirname(file),
          rating: manifest.rating,
        });
      } catch (err) {
        console.warn(`[Registry] Failed to load ${file}: ${err}`);
      }
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

  recordFeedback(skillName: string, positive: boolean, comment?: string): void {
    this.ratingStore.recordFeedback(skillName, positive, comment);
    const skill = this.skills.get(skillName);
    if (skill) {
      const updatedRating = this.ratingStore.getRating(skillName);
      if (updatedRating !== undefined) {
        skill.rating = updatedRating;
        skill.manifest.rating = skill.rating;
      }
    }
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
