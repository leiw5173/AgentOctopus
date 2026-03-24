import fs from 'fs';
import path from 'path';

export interface RatingEntry {
  skillName: string;
  rating: number;
  invocations: number;
  recentFeedback: Array<{ timestamp: string; positive: boolean; comment?: string }>;
}

export interface RatingsStore {
  [skillName: string]: RatingEntry;
}

export class RatingStore {
  private ratingsPath: string;
  private store: RatingsStore = {};

  constructor(ratingsPath: string) {
    this.ratingsPath = ratingsPath;
    this.load();
  }

  private load(): void {
    if (fs.existsSync(this.ratingsPath)) {
      try {
        const raw = fs.readFileSync(this.ratingsPath, 'utf-8');
        this.store = JSON.parse(raw);
      } catch {
        this.store = {};
      }
    }
  }

  private save(): void {
    const dir = path.dirname(this.ratingsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.ratingsPath, JSON.stringify(this.store, null, 2), 'utf-8');
  }

  getOrCreate(skillName: string, initialRating = 3.0): RatingEntry {
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

  recordInvocation(skillName: string): void {
    const entry = this.getOrCreate(skillName);
    entry.invocations++;
    this.save();
  }

  recordFeedback(skillName: string, positive: boolean, comment?: string): void {
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

  getRating(skillName: string): number | undefined {
    return this.store[skillName]?.rating;
  }

  getAll(): RatingsStore {
    return this.store;
  }
}
