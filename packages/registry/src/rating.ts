import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import {
  type RatingDimensions,
  type TaskType,
  computeRoutingScore,
  defaultDimensions,
} from './rating-dimensions.js';

// --- Constants ---

const LATENCY_TARGET_MS = 2000;
const TOKEN_COST_TARGET = 500;
const FEEDBACK_WEIGHT = 0.1;
const MAX_FEEDBACK_ENTRIES = 50;

// --- Types ---

export interface FeedbackEntry {
  id: string;
  timestamp: string;
  positive: boolean;
  comment?: string;
  source: 'cli' | 'web' | 'openclaw' | 'hermes' | 'other';
  taskType?: TaskType;
}

export interface InvocationMetrics {
  totalSuccess: number;
  totalErrors: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgTokenCost: number;
}

export interface RatingEntry {
  skillName: string;
  dimensions: RatingDimensions;
  invocations: number;
  lastInvoked: string;
  recentFeedback: FeedbackEntry[];
  metrics: InvocationMetrics;
}

export interface RatingsStore {
  [skillName: string]: RatingEntry;
}

// --- Old format types (for migration) ---

interface OldFeedbackEntry {
  timestamp: string;
  positive: boolean;
  comment?: string;
}

interface OldRatingEntry {
  skillName: string;
  rating: number;
  invocations: number;
  recentFeedback: OldFeedbackEntry[];
}

// --- Helper ---

function isOldFormat(entry: unknown): entry is OldRatingEntry {
  if (entry === null || typeof entry !== 'object') return false;
  const obj = entry as Record<string, unknown>;
  return 'rating' in obj && !('dimensions' in obj);
}

function migrateOldEntry(old: OldRatingEntry): RatingEntry {
  const dims = defaultDimensions();
  dims.quality = Math.max(0, Math.min(5, old.rating));

  const migratedFeedback: FeedbackEntry[] = (old.recentFeedback ?? []).map(
    (fb) => ({
      id: createFeedbackId(old.skillName, fb.timestamp),
      timestamp: fb.timestamp,
      positive: fb.positive,
      comment: fb.comment,
      source: 'other' as const,
    }),
  );

  return {
    skillName: old.skillName,
    dimensions: dims,
    invocations: old.invocations ?? 0,
    lastInvoked: '',
    recentFeedback: migratedFeedback.slice(0, MAX_FEEDBACK_ENTRIES),
    metrics: {
      totalSuccess: 0,
      totalErrors: 0,
      avgLatencyMs: 0,
      p95LatencyMs: 0,
      avgTokenCost: 0,
    },
  };
}

function createFeedbackId(skillName: string, timestamp: string): string {
  const hash = createHash('sha256');
  hash.update(`${skillName}:${timestamp}`);
  return hash.digest('hex').slice(0, 12);
}

// --- RatingStore class ---

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
        const parsed = JSON.parse(raw);
        // Migrate any old-format entries
        let migrated = false;
        for (const key of Object.keys(parsed)) {
          if (isOldFormat(parsed[key])) {
            parsed[key] = migrateOldEntry(parsed[key]);
            migrated = true;
          }
        }
        this.store = parsed;
        if (migrated) {
          this.save();
        }
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
    const tmp = `${this.ratingsPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.store, null, 2), 'utf-8');
    fs.renameSync(tmp, this.ratingsPath);
  }

  getOrCreate(skillName: string, initialQuality = 3.0): RatingEntry {
    if (!this.store[skillName]) {
      const dims = defaultDimensions();
      dims.quality = initialQuality;
      this.store[skillName] = {
        skillName,
        dimensions: dims,
        invocations: 0,
        lastInvoked: '',
        recentFeedback: [],
        metrics: {
          totalSuccess: 0,
          totalErrors: 0,
          avgLatencyMs: 0,
          p95LatencyMs: 0,
          avgTokenCost: 0,
        },
      };
    }
    return this.store[skillName];
  }

  recordInvocationMetrics(
    skillName: string,
    opts: { success: boolean; latencyMs: number; tokenUsage: number },
  ): void {
    const entry = this.getOrCreate(skillName);
    entry.invocations++;
    entry.lastInvoked = new Date().toISOString();

    const m = entry.metrics;
    const totalRuns = m.totalSuccess + m.totalErrors;

    if (opts.success) {
      m.totalSuccess++;
    } else {
      m.totalErrors++;
    }

    // Update average latency (running average)
    if (opts.latencyMs > 0) {
      m.avgLatencyMs =
        totalRuns === 0
          ? opts.latencyMs
          : (m.avgLatencyMs * totalRuns + opts.latencyMs) / (totalRuns + 1);
      // Simple p95 approximation: keep p95 as max of avg*1.5 and current p95
      m.p95LatencyMs = Math.max(m.p95LatencyMs, m.avgLatencyMs * 1.5);
      if (m.p95LatencyMs === 0 && opts.latencyMs > 0) {
        m.p95LatencyMs = opts.latencyMs;
      }
    }

    // Update average token cost
    if (opts.tokenUsage > 0) {
      m.avgTokenCost =
        totalRuns === 0
          ? opts.tokenUsage
          : (m.avgTokenCost * totalRuns + opts.tokenUsage) / (totalRuns + 1);
    }

    // Recalculate objective dimensions from metrics
    this.recalculateObjectiveDimensions(entry);
    this.save();
  }

  recordFeedback(
    skillName: string,
    positive: boolean,
    comment?: string,
    source: 'cli' | 'web' | 'openclaw' | 'hermes' | 'other' = 'other',
    taskType?: TaskType,
  ): void {
    const entry = this.getOrCreate(skillName);

    // EMA update on quality dimension
    const delta = positive ? FEEDBACK_WEIGHT : -FEEDBACK_WEIGHT;
    entry.dimensions.quality = Math.max(0, Math.min(5, entry.dimensions.quality + delta));

    // Prepend new feedback entry
    const now = new Date().toISOString();
    entry.recentFeedback.unshift({
      id: createFeedbackId(skillName, now),
      timestamp: now,
      positive,
      comment,
      source,
      taskType,
    });

    // Cap at MAX_FEEDBACK_ENTRIES
    entry.recentFeedback = entry.recentFeedback.slice(0, MAX_FEEDBACK_ENTRIES);
    this.save();
  }

  /**
   * LEGACY: delegates to recordInvocationMetrics with success=true, zero metrics.
   */
  recordInvocation(skillName: string): void {
    this.recordInvocationMetrics(skillName, {
      success: true,
      latencyMs: 0,
      tokenUsage: 0,
    });
  }

  getRating(skillName: string): number | undefined {
    return this.store[skillName]?.dimensions.quality;
  }

  getRoutingScore(skillName: string, taskType: TaskType = 'one-shot'): number {
    const entry = this.store[skillName];
    if (!entry) return 0;
    return computeRoutingScore(entry.dimensions, taskType);
  }

  getAll(): RatingsStore {
    return this.store;
  }

  /**
   * Recalculate reliability, latency, and tokenCost dimensions from metrics.
   */
  private recalculateObjectiveDimensions(entry: RatingEntry): void {
    const m = entry.metrics;
    const totalRuns = m.totalSuccess + m.totalErrors;

    if (totalRuns > 0) {
      // Completion: success rate (task produced a useful result)
      entry.dimensions.completion = m.totalSuccess / totalRuns;
      // Reliability: success rate (system didn't crash/error)
      entry.dimensions.reliability = m.totalSuccess / totalRuns;
    }

    // Latency: 1.0 at 0ms, decays to 0.0 at LATENCY_TARGET_MS
    if (m.avgLatencyMs > 0) {
      entry.dimensions.latency = Math.max(
        0,
        1 - m.avgLatencyMs / LATENCY_TARGET_MS,
      );
    }

    // Token cost: 1.0 at 0 tokens, decays to 0.0 at TOKEN_COST_TARGET
    if (m.avgTokenCost > 0) {
      entry.dimensions.tokenCost = Math.max(
        0,
        1 - m.avgTokenCost / TOKEN_COST_TARGET,
      );
    }
  }
}
