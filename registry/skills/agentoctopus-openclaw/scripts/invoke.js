#!/usr/bin/env node
/**
 * AgentOctopus OpenClaw skill — invokes `octopus ask` as a subprocess.
 * No server required. Uses the config written by `octopus connect openclaw`.
 */
import { execFileSync } from 'child_process';

const input = JSON.parse(process.env.OCTOPUS_INPUT || '{}');
const query = input.query || '';

if (!query) {
  console.log(JSON.stringify({ result: 'No query provided.' }));
  process.exit(0);
}

// Resolve the octopus binary — prefer global install, fall back to npx
function findOctopusBin() {
  try {
    execFileSync('octopus', ['--version'], { stdio: 'pipe' });
    return 'octopus';
  } catch {
    return null; // will fall back to npx
  }
}

try {
  const bin = findOctopusBin();
  let result;

  if (bin) {
    result = execFileSync(bin, ['ask', query], {
      encoding: 'utf8',
      env: process.env,
      timeout: 60000,
    });
  } else {
    result = execFileSync('npx', ['--yes', '@agentoctopus/cli', 'ask', query], {
      encoding: 'utf8',
      env: process.env,
      timeout: 90000,
    });
  }

  // octopus ask prints the answer to stdout — wrap in expected schema
  console.log(JSON.stringify({ result: result.trim() }));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  const stderr = err && typeof err === 'object' && 'stderr' in err ? String(err.stderr) : '';
  console.error(JSON.stringify({
    error: 'AgentOctopus invocation failed',
    detail: stderr || message,
  }));
  process.exit(1);
}
