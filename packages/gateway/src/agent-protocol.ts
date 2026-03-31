import express, { type Request, type Response } from 'express';
import { bootstrapEngine, DIRECT_ANSWER_SYSTEM_PROMPT } from './engine.js';
import { sessionManager } from './session.js';
import { syncFromCloud } from '@agentoctopus/registry';

/**
 * OpenClaw-compatible agent-to-agent protocol.
 *
 * POST /agent/ask
 *   Body: { query: string; sessionId?: string; agentId?: string; metadata?: object }
 *   Response: { success: boolean; response: string; skill: string | null; sessionId: string; confidence: number | null }
 *
 * POST /agent/feedback
 *   Body: { skillName: string; positive: boolean; comment?: string }
 *   Response: { success: boolean }
 *
 * GET /agent/health
 *   Response: { status: "ok"; skills: number }
 */
export async function createAgentRouter(rootDir?: string): Promise<express.Router> {
  const engine = await bootstrapEngine(rootDir);
  const router = express.Router();

  router.use(express.json());

  /** POST /agent/ask — main agent-to-agent endpoint */
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

  /** POST /agent/feedback — record thumbs up/down from external agent */
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

  /** GET /agent/health — liveness + skill count */
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', skills: engine.registry.getAll().length });
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

  app.listen(port, () => {
    console.log(`[Agent Gateway] Listening on port ${port}`);
  });
}
