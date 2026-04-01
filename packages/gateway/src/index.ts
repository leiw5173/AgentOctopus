export { bootstrapEngine, resetEngine, type OctopusEngine } from './engine.js';
export { sessionManager, SessionManager, type Session, type SessionMessage } from './session.js';
export { startSlackGateway, type SlackGatewayOptions } from './slack.js';
export { startDiscordGateway, type DiscordGatewayOptions } from './discord.js';
export { startTelegramGateway, type TelegramGatewayOptions } from './telegram.js';
export { createAgentRouter, startAgentGateway } from './agent-protocol.js';

// Security middleware
export {
  authMiddleware,
  loadApiKeys,
  createApiKey,
  revokeApiKey,
  upgradeApiKey,
  validateApiKey,
  flushApiKeys,
  generateApiKey,
  TIER_LIMITS,
  type ApiKeyEntry,
  type ApiKeyTier,
  type ApiKeysStore,
} from './auth-middleware.js';

export { rateLimiter, resetRateLimiter } from './rate-limiter.js';
export { auditLogger, closeAuditLog, resetAuditLogger, type AuditEntry } from './audit-logger.js';
