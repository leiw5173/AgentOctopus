import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { glob } from 'glob';
import { SkillManifestSchema } from './manifest-schema.js';
import { RatingStore } from './rating.js';
export class SkillRegistry {
    skillsDir;
    skills = new Map();
    ratingStore;
    constructor(skillsDir, ratingsPath) {
        this.skillsDir = skillsDir;
        this.ratingStore = new RatingStore(ratingsPath);
    }
    async load() {
        const pattern = path.join(this.skillsDir, '**', 'SKILL.md');
        const files = await glob(pattern);
        for (const file of files) {
            try {
                const raw = fs.readFileSync(file, 'utf-8');
                const { data, content } = matter(raw);
                const manifest = SkillManifestSchema.parse(data);
                // Merge persisted rating over manifest default
                manifest.rating = this.ratingStore.getRating(manifest.name) ?? manifest.rating;
                this.skills.set(manifest.name, {
                    manifest,
                    instructions: content.trim(),
                    dirPath: path.dirname(file),
                    rating: manifest.rating,
                });
            }
            catch (err) {
                console.warn(`[Registry] Failed to load ${file}: ${err}`);
            }
        }
    }
    getAll() {
        return Array.from(this.skills.values()).filter((s) => s.manifest.enabled);
    }
    getByName(name) {
        return this.skills.get(name);
    }
    search(query) {
        const q = query.toLowerCase();
        return this.getAll().filter((s) => s.manifest.name.includes(q) ||
            s.manifest.description.toLowerCase().includes(q) ||
            s.manifest.tags.some((t) => t.toLowerCase().includes(q)));
    }
    recordInvocation(skillName) {
        this.ratingStore.recordInvocation(skillName);
        const skill = this.skills.get(skillName);
        if (skill) {
            skill.manifest.invocations++;
        }
    }
    recordFeedback(skillName, positive, comment) {
        this.ratingStore.recordFeedback(skillName, positive, comment);
        const skill = this.skills.get(skillName);
        if (skill) {
            skill.rating = this.ratingStore.getRating(skillName);
            skill.manifest.rating = skill.rating;
        }
    }
    getRatingStore() {
        return this.ratingStore;
    }
}
//# sourceMappingURL=registry.js.map