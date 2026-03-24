import { type SkillManifest } from './manifest-schema.js';
import { RatingStore } from './rating.js';
export interface LoadedSkill {
    manifest: SkillManifest;
    instructions: string;
    dirPath: string;
    rating: number;
}
export declare class SkillRegistry {
    private skillsDir;
    private skills;
    private ratingStore;
    constructor(skillsDir: string, ratingsPath: string);
    load(): Promise<void>;
    getAll(): LoadedSkill[];
    getByName(name: string): LoadedSkill | undefined;
    search(query: string): LoadedSkill[];
    recordInvocation(skillName: string): void;
    recordFeedback(skillName: string, positive: boolean, comment?: string): void;
    getRatingStore(): RatingStore;
}
//# sourceMappingURL=registry.d.ts.map