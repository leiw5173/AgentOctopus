export { bootstrapEngine, resetEngine, type OctopusEngine } from './engine.js';
export { sessionManager, SessionManager, type Session, type SessionMessage } from './session.js';
// Legacy channel exports (backward compatibility)
export { startSlackGateway, type SlackGatewayOptions } from './slack.js';
export { startDiscordGateway, type DiscordGatewayOptions } from './discord.js';
export { startTelegramGateway, type TelegramGatewayOptions } from './telegram.js';

// New unified channel architecture
export {
  SlackChannel,
  DiscordChannel,
  TelegramChannel,
  WebhookChannel,
  WebchatChannel,
  handleChannelMessage,
  type BaseChannel,
  type ChannelMessage,
  type ChannelReply,
  type HandlerResult,
  type SlackChannelOptions,
  type DiscordChannelOptions,
  type TelegramChannelOptions,
  type WebhookChannelOptions,
  type WebchatChannelOptions,
} from './channels/index.js';
export { createAgentRouter, startAgentGateway } from './agent-protocol.js';
export { getControlPlane, resetControlPlane, type ControlPlane } from './control-plane/control-plane.js';
export { eventBus, type GatewayEvent, type EventListener, type EventBus } from './control-plane/event-bus.js';
export { getDeployMode, isCloudMode, isLocalMode, type DeployMode } from './deploy-mode.js';

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
