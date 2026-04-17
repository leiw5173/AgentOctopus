import type { RatingEntry, FeedbackEntry, RatingsStore } from './rating.js';

export interface GistSyncConfig {
  gistId?: string;
  githubToken?: string;
}

export interface GistContent {
  ratings: RatingsStore;
  feedbackLog: Record<string, FeedbackEntry[]>;
  syncMeta: {
    lastSyncTimestamp: string;
    version: number;
    userId: string;
  };
}

export function mergeRatings(
  local: RatingEntry | undefined,
  cloud: RatingEntry,
): RatingEntry {
  if (!local) return cloud;

  // Merge objective metrics by summing counters
  const mergedMetrics = {
    totalSuccess: local.metrics.totalSuccess + cloud.metrics.totalSuccess,
    totalErrors: local.metrics.totalErrors + cloud.metrics.totalErrors,
    avgLatencyMs: weightedAvg(
      local.metrics.avgLatencyMs, local.invocations,
      cloud.metrics.avgLatencyMs, cloud.invocations,
    ),
    p95LatencyMs: weightedAvg(
      local.metrics.p95LatencyMs, local.invocations,
      cloud.metrics.p95LatencyMs, cloud.invocations,
    ),
    avgTokenCost: weightedAvg(
      local.metrics.avgTokenCost, local.invocations,
      cloud.metrics.avgTokenCost, cloud.invocations,
    ),
  };

  // Merge quality by weighted average of feedback counts
  const localFeedbackCount = local.recentFeedback.length;
  const cloudFeedbackCount = cloud.recentFeedback.length;
  const totalFeedbackCount = localFeedbackCount + cloudFeedbackCount;

  let mergedQuality: number;
  if (totalFeedbackCount === 0) {
    mergedQuality = Math.max(local.dimensions.quality, cloud.dimensions.quality);
  } else {
    mergedQuality = weightedAvg(
      local.dimensions.quality, localFeedbackCount,
      cloud.dimensions.quality, cloudFeedbackCount,
    );
  }

  // Recalculate objective dimensions from merged metrics
  const totalInvocations = local.invocations + cloud.invocations;
  const n = totalInvocations || 1;
  const LATENCY_TARGET_MS = 2000;
  const TOKEN_COST_TARGET = 500;

  const mergedDimensions = {
    completion: mergedMetrics.totalSuccess / n,
    quality: mergedQuality,
    reliability: 1 - (mergedMetrics.totalErrors / n),
    latency: 1 - Math.min(mergedMetrics.avgLatencyMs / LATENCY_TARGET_MS, 1),
    tokenCost: 1 - Math.min(mergedMetrics.avgTokenCost / TOKEN_COST_TARGET, 1),
  };

  return {
    skillName: local.skillName,
    dimensions: mergedDimensions,
    invocations: totalInvocations,
    lastInvoked: local.lastInvoked > cloud.lastInvoked ? local.lastInvoked : cloud.lastInvoked,
    recentFeedback: mergeFeedback(local.recentFeedback, cloud.recentFeedback),
    metrics: mergedMetrics,
  };
}

export function mergeFeedback(
  local: FeedbackEntry[],
  cloud: FeedbackEntry[],
): FeedbackEntry[] {
  const seen = new Set<string>();
  const result: FeedbackEntry[] = [];

  const all = [...local, ...cloud].sort((a, b) =>
    b.timestamp.localeCompare(a.timestamp)
  );

  for (const entry of all) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      result.push(entry);
    }
  }

  return result.slice(0, 50);
}

function weightedAvg(a: number, aWeight: number, b: number, bWeight: number): number {
  const total = aWeight + bWeight;
  if (total === 0) return (a + b) / 2;
  return (a * aWeight + b * bWeight) / total;
}

// ── GitHub Gist API ──────────────────────────────────────────────────────

export async function findOrCreateGist(
  githubToken: string,
): Promise<string> {
  const res = await fetch('https://api.github.com/gists?per_page=100', {
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);

  const gists = await res.json() as Array<{ id: string; description: string }>;
  const existing = gists.find(g => g.description === 'AgentOctopus Ratings Sync');
  if (existing) return existing.id;

  const createRes = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      description: 'AgentOctopus Ratings Sync',
      public: false,
      files: {
        'ratings.json': { content: '{}' },
        'feedback-log.json': { content: '{}' },
        'sync-meta.json': { content: JSON.stringify({ lastSyncTimestamp: '', version: 1, userId: '' }) },
      },
    }),
  });
  if (!createRes.ok) throw new Error(`GitHub API error creating gist: ${createRes.status}`);
  const created = await createRes.json() as { id: string };
  return created.id;
}

export async function pullFromGist(
  gistId: string,
  githubToken: string,
): Promise<GistContent> {
  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);

  const gist = await res.json() as {
    files: Record<string, { content: string }>;
  };

  return {
    ratings: JSON.parse(gist.files['ratings.json']?.content ?? '{}'),
    feedbackLog: JSON.parse(gist.files['feedback-log.json']?.content ?? '{}'),
    syncMeta: JSON.parse(gist.files['sync-meta.json']?.content ?? '{}'),
  };
}

export async function pushToGist(
  gistId: string,
  githubToken: string,
  content: GistContent,
): Promise<void> {
  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: {
        'ratings.json': { content: JSON.stringify(content.ratings, null, 2) },
        'feedback-log.json': { content: JSON.stringify(content.feedbackLog, null, 2) },
        'sync-meta.json': { content: JSON.stringify(content.syncMeta, null, 2) },
      },
    }),
  });
  if (!res.ok) throw new Error(`GitHub API error pushing gist: ${res.status}`);
}
