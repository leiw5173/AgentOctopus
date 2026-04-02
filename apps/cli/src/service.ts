import { startAgentGateway } from '@agentoctopus/gateway';

export async function startService(rootDir: string): Promise<void> {
  const port = Number(process.env.AGENT_GATEWAY_PORT ?? 3002);
  await startAgentGateway(rootDir, port);
}
