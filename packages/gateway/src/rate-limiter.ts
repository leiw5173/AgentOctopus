import type { Request, Response, NextFunction } from 'express';
import type { ApiKeyTier } from './auth-middleware.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface WindowEntry {
  timestamp: number;
}

interface RateLimitBucket {
  windows: WindowEntry[];
}

// ─── Configuration ───────────────────────────────────────────────────────────

const WINDOW_MS = 60_000; // 1 minute sliding window

const TIER_RATE_LIMITS: Record<ApiKeyTier, number> = {
  free: 10,
  pro: 60,
  enterprise: 300,
  admin: 9999,
};

// Default for unauthenticated requests (when auth is disabled)
const DEFAULT_RATE_LIMIT = 30;

// ─── In-Memory Store ─────────────────────────────────────────────────────────

const buckets = new Map<string, RateLimitBucket>();

// Cleanup stale buckets every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS * 2;
  for (const [key, bucket] of buckets.entries()) {
    bucket.windows = bucket.windows.filter((w) => w.timestamp > cutoff);
    if (bucket.windows.length === 0) {
      buckets.delete(key);
    }
  }
}, 5 * 60_000).unref();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getIdentifier(req: Request): string {
  // Prefer API key if attached by auth middleware
  const apiKey = (req as any).apiKey;
  if (apiKey) return `key:${apiKey}`;

  // Fall back to IP
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  return `ip:${ip}`;
}

function getLimit(req: Request): number {
  const entry = (req as any).apiKeyEntry;
  if (entry?.tier) {
    return TIER_RATE_LIMITS[entry.tier as ApiKeyTier] ?? DEFAULT_RATE_LIMIT;
  }
  return DEFAULT_RATE_LIMIT;
}

// ─── Middleware ──────────────────────────────────────────────────────────────

/**
 * Sliding-window rate limiter.
 *
 * Limits are tier-aware when used with the auth middleware:
 *   - free:       10 req/min
 *   - pro:        60 req/min
 *   - enterprise: 300 req/min
 *
 * Sets standard rate-limit headers on every response:
 *   - X-RateLimit-Limit
 *   - X-RateLimit-Remaining
 *   - X-RateLimit-Reset  (epoch seconds)
 *   - Retry-After  (on 429)
 */
export function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  // Skip if rate limiting is disabled
  if (process.env.RATE_LIMIT_ENABLED === 'false') {
    next();
    return;
  }

  const id = getIdentifier(req);
  const limit = getLimit(req);
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  // Get or create bucket
  let bucket = buckets.get(id);
  if (!bucket) {
    bucket = { windows: [] };
    buckets.set(id, bucket);
  }

  // Prune old entries
  bucket.windows = bucket.windows.filter((w) => w.timestamp > windowStart);

  // Check limit
  const current = bucket.windows.length;
  const remaining = Math.max(0, limit - current - 1);
  const resetTime = Math.ceil((windowStart + WINDOW_MS) / 1000);

  // Set headers on all responses
  res.setHeader('X-RateLimit-Limit', limit.toString());
  res.setHeader('X-RateLimit-Remaining', Math.max(0, remaining).toString());
  res.setHeader('X-RateLimit-Reset', resetTime.toString());

  if (current >= limit) {
    const retryAfter = Math.ceil((bucket.windows[0]!.timestamp + WINDOW_MS - now) / 1000);

    res.setHeader('Retry-After', Math.max(1, retryAfter).toString());
    res.status(429).json({
      success: false,
      error: `Rate limit exceeded. Maximum ${limit} requests per minute for your tier.`,
      retryAfter: Math.max(1, retryAfter),
      upgrade: 'https://api.agentoctopus.dev/billing',
    });
    return;
  }

  // Record this request
  bucket.windows.push({ timestamp: now });

  next();
}

/** Reset all rate-limit buckets (for testing). */
export function resetRateLimiter(): void {
  buckets.clear();
}
