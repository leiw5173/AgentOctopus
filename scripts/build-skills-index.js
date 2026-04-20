#!/usr/bin/env node
/**
 * Build the skills index bundle for the GitHub Release.
 * Standalone ESM script — no workspace imports.
 *
 * Usage: node scripts/build-skills-index.js
 * Output: skills-index.json + skills-index.json.gz (in CWD)
 *
 * Performance: processes skills in parallel (CONCURRENCY workers) so the
 * full 5,000+ skill list completes in ~15 minutes instead of 6+ hours.
 */
import { inflateRawSync, gzipSync } from 'zlib';
import fs from 'fs';
import path from 'path';

const CLAWHUB_BASE = 'https://clawhub.ai';
const AWESOME_README_URL =
  'https://raw.githubusercontent.com/VoltAgent/awesome-openclaw-skills/main/README.md';
const AWESOME_CATEGORY_BASE =
  'https://raw.githubusercontent.com/VoltAgent/awesome-openclaw-skills/main/categories/';

/** Number of skills processed in parallel. Keep low enough to avoid 429s. */
const CONCURRENCY = 8;

/** Delay between requests within a single worker (ms). */
const INTER_REQUEST_DELAY_MS = 150;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchWithRetry(url, retries = 3) {
  const headers = {};
  if (process.env.CLAWHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.CLAWHUB_TOKEN}`;
  }
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, { headers });
    if (res.status === 429 && attempt < retries) {
      const wait = parseInt(res.headers.get('retry-after') ?? '10', 10) * 1000 + 1000;
      process.stderr.write(`  [429] waiting ${Math.ceil(wait / 1000)}s...\n`);
      await sleep(wait);
      continue;
    }
    if (res.status >= 500 && attempt < retries) {
      await sleep(2000 * Math.pow(2, attempt));
      continue;
    }
    return res;
  }
  throw new Error('Fetch retry exhausted');
}

// ── ZIP extractor ──────────────────────────────────────────────────────────

function parseZipEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset < buffer.length - 4) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.toString('utf8', nameStart, nameStart + nameLength);
    const dataStart = nameStart + nameLength + extraLength;
    const isDirectory = name.endsWith('/');
    let data;
    if (compressionMethod === 0) {
      data = buffer.subarray(dataStart, dataStart + compressedSize);
    } else if (compressionMethod === 8) {
      data = inflateRawSync(buffer.subarray(dataStart, dataStart + compressedSize));
    } else {
      offset = dataStart + compressedSize;
      continue;
    }
    entries.push({ name, isDirectory, data });
    offset = dataStart + compressedSize;
  }
  return entries;
}

function extractFileFromZip(zipBuffer, targetName) {
  for (const entry of parseZipEntries(zipBuffer)) {
    if (path.basename(entry.name) === targetName && !entry.isDirectory) {
      return entry.data.toString('utf8');
    }
  }
  return null;
}

/**
 * Extract all files from the scripts/ directory in a ZIP.
 * Returns a map of filename → content, or null if no scripts found.
 */
function extractScriptsFromZip(zipBuffer) {
  const scripts = {};
  for (const entry of parseZipEntries(zipBuffer)) {
    if (entry.isDirectory) continue;
    // Match files inside a scripts/ directory (e.g. "skill-name/scripts/invoke.js")
    const parts = entry.name.split('/');
    const scriptsIdx = parts.indexOf('scripts');
    if (scriptsIdx >= 0 && scriptsIdx < parts.length - 1) {
      const filename = parts.slice(scriptsIdx + 1).join('/');
      scripts[filename] = entry.data.toString('utf8');
    }
  }
  return Object.keys(scripts).length > 0 ? scripts : null;
}

// ── Slug fetching ──────────────────────────────────────────────────────────

async function fetchAwesomeSlugs() {
  const slugSet = new Set();
  const SKILL_URL_RE = /https:\/\/clawskills\.sh\/skills\/([\w.%-]+)/g;

  const parseMarkdown = (text) => {
    SKILL_URL_RE.lastIndex = 0;
    let m;
    while ((m = SKILL_URL_RE.exec(text)) !== null) slugSet.add(m[1]);
  };

  const readmeRes = await fetchWithRetry(AWESOME_README_URL);
  if (!readmeRes.ok) throw new Error(`Failed to fetch README (${readmeRes.status})`);
  const readme = await readmeRes.text();

  const catRe = /categories\/([\w-]+\.md)/g;
  const catFiles = [];
  let cm;
  while ((cm = catRe.exec(readme)) !== null) {
    if (!catFiles.includes(cm[1])) catFiles.push(cm[1]);
  }

  if (catFiles.length === 0) {
    parseMarkdown(readme);
  } else {
    for (const file of catFiles) {
      const res = await fetchWithRetry(`${AWESOME_CATEGORY_BASE}${file}`);
      if (res.ok) parseMarkdown(await res.text());
    }
  }

  return Array.from(slugSet);
}

// ── Per-skill fetch (resolve + meta + zip in one worker pass) ──────────────

/**
 * Attempt to fetch a skill by progressively stripping the owner prefix.
 * Returns { slug, meta } for the first successful API hit, or null.
 */
async function resolveSlugAndMeta(ownerSlug) {
  const candidates = [ownerSlug];
  let remainder = ownerSlug;
  while (remainder.includes('-')) {
    remainder = remainder.slice(remainder.indexOf('-') + 1);
    candidates.push(remainder);
  }
  for (const candidate of candidates) {
    const res = await fetchWithRetry(
      `${CLAWHUB_BASE}/api/v1/skills/${encodeURIComponent(candidate)}`
    );
    if (res.ok) return { slug: candidate, meta: await res.json() };
    if (res.status !== 404) return null;
  }
  return null;
}

async function processSkill(ownerSlug) {
  const resolved = await resolveSlugAndMeta(ownerSlug);
  if (!resolved) return null;

  const { slug, meta } = resolved;
  const version = meta.latestVersion?.version || meta.skill?.tags?.latest || 'latest';
  const author = meta.owner?.handle || meta.owner?.displayName || 'unknown';
  const name = meta.skill?.displayName || slug;
  const description = meta.skill?.summary || '';

  await sleep(INTER_REQUEST_DELAY_MS);

  const zipUrl = `${CLAWHUB_BASE}/api/v1/download?slug=${encodeURIComponent(slug)}&version=${encodeURIComponent(version)}`;
  const zipRes = await fetchWithRetry(zipUrl);
  if (!zipRes.ok) return null;

  const zipBuffer = Buffer.from(await zipRes.arrayBuffer());
  const skillMd = extractFileFromZip(zipBuffer, 'SKILL.md');
  if (!skillMd) return null;

  const metaJson = extractFileFromZip(zipBuffer, '_meta.json');

  // Extract ALL script files from the scripts/ directory (not just invoke.js)
  const scripts = extractScriptsFromZip(zipBuffer);

  return { slug, name, description, version, author, skillMd, metaJson, scripts };
}

// ── Concurrency pool ───────────────────────────────────────────────────────

/**
 * Run `tasks` with at most `limit` in-flight at once.
 * Returns results in the same order as tasks (nulls for failures).
 */
async function pLimit(tasks, limit) {
  const results = new Array(tasks.length).fill(null);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++;
      try {
        results[idx] = await tasks[idx]();
      } catch {
        results[idx] = null;
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching slug list from awesome-openclaw-skills...');
  const ownerSlugs = await fetchAwesomeSlugs();
  console.log(`Found ${ownerSlugs.length} slugs. Processing with ${CONCURRENCY} workers...`);

  let done = 0;
  const total = ownerSlugs.length;

  const tasks = ownerSlugs.map((ownerSlug) => async () => {
    const result = await processSkill(ownerSlug);
    done++;
    const status = result ? 'OK' : 'SKIP';
    process.stdout.write(`[${done}/${total}] ${ownerSlug} ... ${status}\n`);
    await sleep(INTER_REQUEST_DELAY_MS);
    return result;
  });

  const results = await pLimit(tasks, CONCURRENCY);
  const skills = results.filter(Boolean);

  console.log(`\nBuilding index with ${skills.length} skills...`);

  const index = {
    version: '1',
    builtAt: new Date().toISOString(),
    skills,
  };

  const jsonStr = JSON.stringify(index);
  fs.writeFileSync('skills-index.json', jsonStr, 'utf8');
  fs.writeFileSync('skills-index.json.gz', gzipSync(Buffer.from(jsonStr)));

  console.log(`Done. skills-index.json (${(jsonStr.length / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`      skills-index.json.gz (${(fs.statSync('skills-index.json.gz').size / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
