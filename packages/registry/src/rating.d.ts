export interface RatingEntry {
    skillName: string;
    rating: number;
    invocations: number;
    recentFeedback: Array<{
        timestamp: string;
        positive: boolean;
        comment?: string;
    }>;
}
export interface RatingsStore {
    [skillName: string]: RatingEntry;
}
export declare class RatingStore {
    private ratingsPath;
    private store;
    constructor(ratingsPath: string);
    private load;
    private save;
    getOrCreate(skillName: string, initialRating?: number): RatingEntry;
    recordInvocation(skillName: string): void;
    recordFeedback(skillName: string, positive: boolean, comment?: string): void;
    getRating(skillName: string): number;
    getAll(): RatingsStore;
}
//# sourceMappingURL=rating.d.ts.map