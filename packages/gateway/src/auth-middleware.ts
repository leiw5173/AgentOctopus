import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ApiKeyTier = 'free' | 'pro' | 'enterprise' | 'admin';

export interface ApiKeyEntry {
  userId: string;
  email: string;
  tier: ApiKeyTier;
  createdAt: string;
  expiresAt?: string;
  usage: {
    daily: number;
    monthly: number;
    lastDailyReset: string;
    lastMonthlyReset: string;
  };
  active: boolean;
  description?: string;
}

export interface ApiKeysStore {
  keys: Record<string, ApiKeyEntry>;
}

// ─── Tier Limits ─────────────────────────────────────────────────────────────

export const TIER_LIMITS: Record<ApiKeyTier, { reqPerMin: number; reqPerDay: number }> = {
  free:       { reqPerMin: 10,  reqPerDay: 100   },
  pro:        { reqPerMin: 60,  reqPerDay: 5000  },
  enterprise: { reqPerMin: 300, reqPerDay: 50000 },
  admin:      { reqPerMin: 9999, reqPerDay: 999999 },
};

// ─── Store ───────────────────────────────────────────────────────────────────

let _store: ApiKeysStore | null = null;
let _storePath: string = '';

function getStorePath(): string {
  if (_storePath) return _storePath;
  const root = process.env.OCTOPUS_ROOT ?? process.cwd();
  _storePath = process.env.API_KEYS_PATH ?? path.join(root, 'api-keys.json');
  return _storePath;
}

export function loadApiKeys(filePath?: string): ApiKeysStore {
  const p = filePath ?? getStorePath();
  _storePath = p;

  if (fs.existsSync(p)) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      _store = JSON.parse(raw) as ApiKeysStore;
    } catch {
      _store = { keys: {} };
    }
  } else {
    _store = { keys: {} };
  }

  return _store;
}

function getStore(): ApiKeysStore {
  if (!_store) loadApiKeys();
  return _store!;
}

function saveStore(): void {
  fs.writeFileSync(getStorePath(), JSON.stringify(getStore(), null, 2), 'utf8');
}

// ─── Key Management ──────────────────────────────────────────────────────────

export function generateApiKey(prefix = 'ak'): string {
  const random = crypto.randomBytes(24).toString('base64url');
  return `${prefix}_${random}`;
}

export function createApiKey(
  opts: { email: string; tier?: ApiKeyTier; userId?: string; description?: string }
): { key: string; entry: ApiKeyEntry } {
  const store = getStore();
  const key = generateApiKey();
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  const entry: ApiKeyEntry = {
    userId: opts.userId ?? `user_${crypto.randomBytes(8).toString('hex')}`,
    email: opts.email,
    tier: opts.tier ?? 'free',
    createdAt: now,
    usage: { daily: 0, monthly: 0, lastDailyReset: today, lastMonthlyReset: today.slice(0, 7) },
    active: true,
    description: opts.description,
  };

  store.keys[key] = entry;
  saveStore();

  return { key, entry };
}

export function revokeApiKey(key: string): boolean {
  const store = getStore();
  if (!store.keys[key]) return false;
  store.keys[key]!.active = false;
  saveStore();
  return true;
}

export function upgradeApiKey(key: string, tier: ApiKeyTier): boolean {
  const store = getStore();
  if (!store.keys[key]) return false;
  store.keys[key]!.tier = tier;
  saveStore();
  return true;
}

export function validateApiKey(apiKey: string): ApiKeyEntry | null {
  const store = getStore();
  const entry = store.keys[apiKey];
  if (!entry) return null;
  if (!entry.active) return null;
  if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) return null;
  return entry;
}

export function incrementUsage(apiKey: string): void {
  const store = getStore();
  const entry = store.keys[apiKey];
  if (!entry) return;

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const thisMonth = today.slice(0, 7);

  // Reset daily counter if new day
  if (entry.usage.lastDailyReset !== today) {
    entry.usage.daily = 0;
    entry.usage.lastDailyReset = today;
  }

  // Reset monthly counter if new month
  if (entry.usage.lastMonthlyReset !== thisMonth) {
    entry.usage.monthly = 0;
    entry.usage.lastMonthlyReset = thisMonth;
  }

  entry.usage.daily += 1;
  entry.usage.monthly += 1;

  // Save periodically (every 10 requests to reduce I/O)
  if (entry.usage.daily % 10 === 0) {
    saveStore();
  }
}

export function checkQuota(apiKey: string): { allowed: boolean; reason?: string } {
  const store = getStore();
  const entry = store.keys[apiKey];
  if (!entry) return { allowed: false, reason: 'Invalid API key' };

  const limits = TIER_LIMITS[entry.tier];
  const today = new Date().toISOString().slice(0, 10);

  // Reset if needed before checking
  if (entry.usage.lastDailyReset !== today) {
    entry.usage.daily = 0;
    entry.usage.lastDailyReset = today;
  }

  if (entry.usage.daily >= limits.reqPerDay) {
    return {
      allowed: false,
      reason: `Daily limit reached (${limits.reqPerDay}/day for ${entry.tier} tier). Upgrade at https://api.agentoctopus.dev/billing`,
    };
  }

  return { allowed: true };
}

/** Force-save the store (e.g., on shutdown). */
export function flushApiKeys(): void {
  if (_store) saveStore();
}

// ─── Express Middleware ──────────────────────────────────────────────────────

/** Public paths that don't require authentication. */
const PUBLIC_PATHS = ['/health', '/register'];

/**
 * Express middleware that validates API key from:
 *   - Authorization: Bearer <key>
 *   - X-API-Key: <key>
 *   - Query param: ?apiKey=<key>
 *
 * Attaches `req.apiKeyEntry` and `req.apiKey` on success.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip auth if disabled
  if (process.env.AUTH_ENABLED === 'false') {
    next();
    return;
  }

  // Skip auth for public paths
  if (PUBLIC_PATHS.some((p) => req.path === p || req.path.startsWith(p))) {
    next();
    return;
  }

  // Extract API key from various sources
  let apiKey: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    apiKey = authHeader.slice(7);
  }

  if (!apiKey) {
    apiKey = req.headers['x-api-key'] as string | undefined;
  }

  if (!apiKey) {
    apiKey = req.query.apiKey as string | undefined;
  }

  if (!apiKey) {
    res.status(401).json({
      success: false,
      error: 'Authentication required. Provide API key via Authorization: Bearer <key>, X-API-Key header, or ?apiKey= query param.',
      docs: 'https://api.agentoctopus.dev/docs',
    });
    return;
  }

  // Validate the key
  const entry = validateApiKey(apiKey);
  if (!entry) {
    res.status(401).json({
      success: false,
      error: 'Invalid or expired API key.',
    });
    return;
  }

  // Check quota
  const quota = checkQuota(apiKey);
  if (!quota.allowed) {
    res.status(402).json({
      success: false,
      error: quota.reason,
      upgrade: 'https://api.agentoctopus.dev/billing',
    });
    return;
  }

  // Increment usage
  incrementUsage(apiKey);

  // Attach to request for downstream use
  (req as any).apiKey = apiKey;
  (req as any).apiKeyEntry = entry;

  next();
}
