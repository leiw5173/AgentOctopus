export type { BaseChannel, ChannelMessage, ChannelReply } from './base-channel.js';
export { handleChannelMessage, type HandlerResult } from './channel-handler.js';

export { SlackChannel, startSlackGateway, type SlackChannelOptions } from './slack-channel.js';
export { DiscordChannel, startDiscordGateway, type DiscordChannelOptions } from './discord-channel.js';
export { TelegramChannel, startTelegramGateway, type TelegramChannelOptions } from './telegram-channel.js';
export { WebhookChannel, type WebhookChannelOptions } from './webhook-channel.js';
export { WebchatChannel, type WebchatChannelOptions } from './webchat-channel.js';
