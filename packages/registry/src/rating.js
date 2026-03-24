import fs from 'fs';
import path from 'path';
export class RatingStore {
    ratingsPath;
    store = {};
    constructor(ratingsPath) {
        this.ratingsPath = ratingsPath;
        this.load();
    }
    load() {
        if (fs.existsSync(this.ratingsPath)) {
            try {
                const raw = fs.readFileSync(this.ratingsPath, 'utf-8');
                this.store = JSON.parse(raw);
            }
            catch {
                this.store = {};
            }
        }
    }
    save() {
        const dir = path.dirname(this.ratingsPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(this.ratingsPath, JSON.stringify(this.store, null, 2), 'utf-8');
    }
    getOrCreate(skillName, initialRating = 3.0) {
        if (!this.store[skillName]) {
            this.store[skillName] = {
                skillName,
                rating: initialRating,
                invocations: 0,
                recentFeedback: [],
            };
        }
        return this.store[skillName];
    }
    recordInvocation(skillName) {
        const entry = this.getOrCreate(skillName);
        entry.invocations++;
        this.save();
    }
    recordFeedback(skillName, positive, comment) {
        const entry = this.getOrCreate(skillName);
        const weight = 0.1;
        const delta = positive ? weight : -weight;
        entry.rating = Math.max(0, Math.min(5, entry.rating + delta));
        entry.recentFeedback.unshift({
            timestamp: new Date().toISOString(),
            positive,
            comment,
        });
        // Keep last 50 feedback entries
        entry.recentFeedback = entry.recentFeedback.slice(0, 50);
        this.save();
    }
    getRating(skillName) {
        return this.store[skillName]?.rating ?? 3.0;
    }
    getAll() {
        return this.store;
    }
}
//# sourceMappingURL=rating.js.map