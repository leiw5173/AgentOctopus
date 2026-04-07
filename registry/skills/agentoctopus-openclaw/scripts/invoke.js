#!/usr/bin/env node
/**
 * AgentOctopus OpenClaw skill — invokes `octopus ask` as a subprocess.
 * No server required. Uses the config written by `octopus connect openclaw`.
 */
const { execFileSync } = require('child_process');

const input = JSON.parse(process.env.OCTOPUS_INPUT || '{}');
const query = input.query || '';

if (!query) {
  console.log(JSON.stringify({ result: 'No query provided.' }));
  process.exit(0);
}

// Resolve the octopus binary — prefer global install if it supports --no-prompt,
// otherwise fall back to npx so we always get a version that has the flag.
function findOctopusBin() {
  try {
    const help = execFileSync('octopus', ['ask', '--help'], { encoding: 'utf8', stdio: 'pipe' });
    if (help.includes('--no-prompt')) return 'octopus';
    return null; // global binary is too old, fall back to npx
  } catch {
    return null;
  }
}

try {
  const bin = findOctopusBin();
  let result;

  if (bin) {
    result = execFileSync(bin, ['ask', '--no-prompt', query], {
      encoding: 'utf8',
      env: process.env,
      timeout: 60000,
    });
  } else {
    result = execFileSync('npx', ['--yes', '@agentoctopus/cli', 'ask', '--no-prompt', query], {
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
