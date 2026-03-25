import path from 'path';
import { fileURLToPath } from 'url';
import { startAgentGateway } from '../agent-protocol.js';

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const rootDir = path.resolve(currentDir, '../../../../');
const port = Number(process.env.AGENT_GATEWAY_PORT ?? 3002);

startAgentGateway(rootDir, port).catch((error) => {
  console.error('[Agent Gateway] Failed to start');
  console.error(error);
  process.exit(1);
});
