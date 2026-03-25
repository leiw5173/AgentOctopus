import express, { type Request, type Response } from 'express';
import { bootstrapEngine, DIRECT_ANSWER_SYSTEM_PROMPT } from './engine.js';
import { sessionManager } from './session.js';

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
