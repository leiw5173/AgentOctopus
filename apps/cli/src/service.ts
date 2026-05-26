import chalk from 'chalk';
import {
  startAgentGateway,
  getControlPlane,
  SlackChannel,
  DiscordChannel,
  TelegramChannel,
  WebhookChannel,
  WebchatChannel,
} from '@agentoctopus/gateway';
import { loadConfig, getConfig } from '@agentoctopus/core';

export async function startService(rootDir: string): Promise<void> {
  const config = getConfig();
  const port = Number(process.env.AGENT_GATEWAY_PORT ?? config.gateway.port ?? 3002);

  // ── Start the control plane first ────────────────────────────────────────
  console.log(chalk.gray('  Starting Control Plane...'));
  const cp = await getControlPlane({ rootDir });

  // ── Register and start configured channels ───────────────────────────────
  const channelPromises: Promise<void>[] = [];

  // Slack
  if (process.env.SLACK_BOT_TOKEN) {
    console.log(chalk.gray('  Registering Slack channel...'));
    const slack = new SlackChannel({
      appOptions: {
        token: process.env.SLACK_BOT_TOKEN,
        signingSecret: process.env.SLACK_SIGNING_SECRET,
        socketMode: true,
        appToken: process.env.SLACK_APP_TOKEN,
      },
      rootDir,
    });
    cp.registerChannel(slack);
    channelPromises.push(slack.start());
  }

  // Discord
  if (process.env.DISCORD_TOKEN) {
    console.log(chalk.gray('  Registering Discord channel...'));
    const discord = new DiscordChannel({
      token: process.env.DISCORD_TOKEN,
      rootDir,
    });
    cp.registerChannel(discord);
    channelPromises.push(discord.start());
  }

  // Telegram
  if (process.env.TELEGRAM_BOT_TOKEN) {
    console.log(chalk.gray('  Registering Telegram channel...'));
    const telegram = new TelegramChannel({
      token: process.env.TELEGRAM_BOT_TOKEN,
      rootDir,
    });
    cp.registerChannel(telegram);
    channelPromises.push(telegram.start());
  }

  // Webhook (always available if configured)
  const webhookConfig = config.gateway as any;
  if (webhookConfig?.webhookPort) {
    console.log(chalk.gray('  Registering Webhook channel...'));
    const webhook = new WebhookChannel({
      port: webhookConfig.webhookPort,
      path: webhookConfig.webhookPath ?? '/webhook',
      secret: webhookConfig.webhookSecret,
      rootDir,
    });
    cp.registerChannel(webhook);
    channelPromises.push(webhook.start());
  }

  // WebChat (always available)
  const webchatPort = (config as any).canvas?.port ?? 3006;
  console.log(chalk.gray('  Registering WebChat channel...'));
  const webchat = new WebchatChannel({ port: webchatPort, rootDir });
  cp.registerChannel(webchat);
  channelPromises.push(webchat.start());

  // Wait for all channels to start
  await Promise.all(channelPromises);

  // ── Start the agent HTTP gateway ────────────────────────────────────────
  console.log(chalk.gray('  Starting Agent HTTP gateway...'));
  await startAgentGateway(rootDir, port);
}
