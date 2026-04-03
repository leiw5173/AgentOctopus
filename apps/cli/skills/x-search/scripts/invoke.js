#!/usr/bin/env node
// x-search skill — search X/Twitter via xAI Grok API
const { spawn } = require('child_process');
const path = require('path');

const input = JSON.parse(process.env.OCTOPUS_INPUT || '{}');
const query = input.query;
if (!query || typeof query !== 'string') {
  console.log(JSON.stringify({ report: 'Missing or invalid query', status: 'error' }));
  process.exit(0);
}

const args = [query];

if (input.handles) {
  const handles = Array.isArray(input.handles) ? input.handles.join(',') : input.handles;
  args.push('--handles', handles);
}
if (input.exclude) {
  const exclude = Array.isArray(input.exclude) ? input.exclude.join(',') : input.exclude;
  args.push('--exclude', exclude);
}
if (input.from) args.push('--from', input.from);
if (input.to) args.push('--to', input.to);
if (input.images) args.push('--images');
if (input.video) args.push('--video');

// Path to search.py relative to this script's location
const scriptPath = path.resolve(__dirname, 'search.py');

const proc = spawn('python3', [scriptPath, ...args], {
  env: { ...process.env },
  timeout: 120000,
});

let stdout = '';
let stderr = '';

proc.stdout.on('data', (data) => { stdout += data; });
proc.stderr.on('data', (data) => { stderr += data; });

proc.on('close', (code) => {
  if (code !== 0) {
    console.log(JSON.stringify({ report: `Search failed: ${stderr || 'unknown error'}`, status: 'error' }));
    process.exit(0);
  }
  try {
    const result = JSON.parse(stdout);
    console.log(JSON.stringify({ report: result.text || '', status: result.status || 'completed' }));
  } catch (e) {
    console.log(JSON.stringify({ report: `Failed to parse result: ${e.message}`, status: 'error' }));
  }
});

proc.on('error', (err) => {
  console.log(JSON.stringify({ report: `Spawn error: ${err.message}`, status: 'error' }));
});
