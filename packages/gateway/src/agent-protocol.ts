import express, { type Request, type Response } from 'express';
import { bootstrapEngine, DIRECT_ANSWER_SYSTEM_PROMPT } from './engine.js';
import { sessionManager } from './session.js';
import { authMiddleware, loadApiKeys, createApiKey, revokeApiKey, flushApiKeys, validateApiKey } from './auth-middleware.js';
import { rateLimiter, resetRateLimiter } from './rate-limiter.js';
import { auditLogger, closeAuditLog } from './audit-logger.js';
import { syncFromCloud } from '@agentoctopus/registry';

/**
 * OpenClaw-compatible agent-to-agent protocol with security middleware.
 *
 * Public endpoints (no auth required):
 *   GET  /agent/health       — liveness + skill count
 *   POST /agent/register     — self-service API key registration (free tier)
 *
 * Authenticated endpoints:
 *   POST /agent/ask          — route query to best skill
 *   POST /agent/feedback     — record thumbs up/down
 *
 * Admin endpoints (admin API key required):
 *   POST /agent/keys/create  — create a new API key
 *   POST /agent/keys/revoke  — revoke an API key
 *   GET  /agent/keys         — list all API keys
 */
export async function createAgentRouter(rootDir?: string): Promise<express.Router> {
  const engine = await bootstrapEngine(rootDir);
  const router = express.Router();

  // Load API keys store
  loadApiKeys();

  // ── Global middleware (order matters) ──────────────────────────────────
  router.use(express.json());
  router.use(auditLogger);     // Log all requests
  router.use(authMiddleware);  // Validate API key (skips public paths)
  router.use(rateLimiter);     // Rate-limit by key/IP

  // ── CORS ───────────────────────────────────────────────────────────────
  router.use((_req: Request, res: Response, next) => {
    const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS?.split(',') ?? ['*'];
    const origin = _req.headers.origin;

    if (allowedOrigins.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (_req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });

  // ── Public: Health ─────────────────────────────────────────────────────

  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      skills: engine.registry.getAll().length,
      version: '0.3.4',
      auth: process.env.AUTH_ENABLED !== 'false',
    });
  });

  // ── Public: Self-service registration ──────────────────────────────────

  router.post('/register', (req: Request, res: Response) => {
    const { email } = req.body as { email?: string };

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      res.status(400).json({ success: false, error: 'Valid email is required' });
      return;
    }

    try {
      const { key, entry } = createApiKey({ email, tier: 'free' });

      res.status(201).json({
        success: true,
        apiKey: key,
        tier: entry.tier,
        limits: {
          requestsPerMinute: 10,
          requestsPerDay: 100,
        },
        message: 'Store this API key securely — it will not be shown again.',
        upgrade: 'https://api.agentoctopus.dev/billing',
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // ── Authenticated: Ask ─────────────────────────────────────────────────

  router.post('/ask', async (req: Request, res: Response) => {
    const { query, sessionId, agentId = 'external-agent', metadata = {} } = req.body as {
      query?: string;
      sessionId?: string;
      agentId?: string;
      metadata?: Record<string, unknown>;
    };

    if (!query || typeof query !== 'string') {
      res.status(400).json({ success: false, error: 'query is required' });
      return;
    }

    // Resolve or create session
    const channelId = sessionId ?? agentId;
    const session = sessionId
      ? sessionManager.getById(sessionId) ?? sessionManager.getOrCreate(channelId, agentId, 'agent')
      : sessionManager.getOrCreate(channelId, agentId, 'agent');

    session.metadata = { ...session.metadata, ...metadata };
    sessionManager.addMessage(session, { role: 'user', content: query, timestamp: Date.now() });

    try {
      const [routing] = await engine.router.route(query);
      if (!routing) {
        const answer = await engine.chatClient.chat(DIRECT_ANSWER_SYSTEM_PROMPT, query);

        sessionManager.addMessage(session, {
          role: 'assistant',
          content: answer,
          timestamp: Date.now(),
        });

        res.status(200).json({
          success: true,
          response: answer,
          skill: null,
          sessionId: session.id,
          confidence: null,
        });
        return;
      }

      const result = await engine.executor.execute(routing.skill, { query });

      sessionManager.addMessage(session, {
        role: 'assistant',
        content: result.formattedOutput,
        timestamp: Date.now(),
        skillUsed: routing.skill.manifest.name,
      });

      res.json({
        success: true,
        response: result.formattedOutput,
        skill: routing.skill.manifest.name,
        sessionId: session.id,
        confidence: routing.score,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // ── Authenticated: Feedback ────────────────────────────────────────────

  router.post('/feedback', async (req: Request, res: Response) => {
    const { skillName, positive, comment } = req.body as {
      skillName?: string;
      positive?: boolean;
      comment?: string;
    };

    if (!skillName || typeof positive !== 'boolean') {
      res.status(400).json({ success: false, error: 'skillName and positive (boolean) are required' });
      return;
    }

    engine.registry.recordFeedback(skillName, positive, comment);
    res.json({ success: true });
  });

  // ── Admin: Key Management ──────────────────────────────────────────────

  router.post('/keys/create', (req: Request, res: Response) => {
    const caller = (req as any).apiKeyEntry;
    if (!caller || caller.tier !== 'admin') {
      res.status(403).json({ success: false, error: 'Admin access required' });
      return;
    }

    const { email, tier, description } = req.body as {
      email?: string;
      tier?: string;
      description?: string;
    };

    if (!email) {
      res.status(400).json({ success: false, error: 'email is required' });
      return;
    }

    const { key, entry } = createApiKey({
      email,
      tier: (tier as any) || 'free',
      description,
    });

    res.status(201).json({ success: true, apiKey: key, entry });
  });

  router.post('/keys/revoke', (req: Request, res: Response) => {
    const caller = (req as any).apiKeyEntry;
    if (!caller || caller.tier !== 'admin') {
      res.status(403).json({ success: false, error: 'Admin access required' });
      return;
    }

    const { apiKey } = req.body as { apiKey?: string };
    if (!apiKey) {
      res.status(400).json({ success: false, error: 'apiKey is required' });
      return;
    }

    const revoked = revokeApiKey(apiKey);
    res.json({ success: revoked, message: revoked ? 'Key revoked' : 'Key not found' });
  });

  /** GET /agent/skills — list all registered skills */
  router.get('/skills', (_req: Request, res: Response) => {
    const skills = engine.registry.getAll().map((s) => ({
      name: s.manifest.name,
      description: s.manifest.description,
      adapter: s.manifest.adapter,
      tags: s.manifest.tags,
      rating: s.rating,
      invocations: s.manifest.invocations,
    }));
    res.json({ skills });
  });

  /** GET /agent/skills/export — full skill data for cloud-to-local sync */
  router.get('/skills/export', (_req: Request, res: Response) => {
    const skills = engine.registry.getAll().map((s) => {
      const files = engine.registry.getSkillFiles(s.manifest.name);
      return {
        name: s.manifest.name,
        version: s.manifest.version,
        skillMd: files?.skillMd ?? '',
        scripts: files?.scripts ?? {},
      };
    });
    res.json({ skills, exportedAt: new Date().toISOString() });
  });

  /** POST /agent/sync — trigger skill sync from a cloud instance */
  router.post('/sync', async (req: Request, res: Response) => {
    const { cloudUrl, force } = req.body as { cloudUrl?: string; force?: boolean };
    const url = cloudUrl ?? process.env.CLOUD_URL;

    if (!url) {
      res.status(400).json({ success: false, error: 'cloudUrl is required (body or CLOUD_URL env)' });
      return;
    }

    try {
      const skillsDir = process.env.REGISTRY_PATH ?? 'registry/skills';
      const result = await syncFromCloud(url, skillsDir, force);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  return router;
}

/**
 * Convenience: start a standalone Express server exposing the agent protocol.
 * Used when running the gateway as its own microservice.
 */
export async function startAgentGateway(rootDir?: string, port = 3002): Promise<void> {
  const app = express();
  const router = await createAgentRouter(rootDir);
  app.use('/agent', router);

  // Graceful shutdown
  const shutdown = () => {
    console.log('[Agent Gateway] Shutting down...');
    flushApiKeys();
    closeAuditLog();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  app.listen(port, () => {
    const authStatus = process.env.AUTH_ENABLED !== 'false' ? '🔒 auth ON' : '🔓 auth OFF';
    const rateStatus = process.env.RATE_LIMIT_ENABLED !== 'false' ? '⏱ rate-limit ON' : '⏱ rate-limit OFF';
    console.log(`[Agent Gateway] Listening on port ${port} [${authStatus}] [${rateStatus}]`);
  });
}
