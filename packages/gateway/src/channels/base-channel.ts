import type { OctopusEngine } from '../engine.js';

export interface ChannelMessage {
  text: string;
  channelId: string;
  userId: string;
  platform: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelReply {
  text: string;
  threadId?: string;
}

export interface BaseChannel {
  readonly channelType: string;
  start(engine: OctopusEngine): Promise<void>;
  stop(): Promise<void>;
  send(channelId: string, reply: ChannelReply): Promise<void>;
}
