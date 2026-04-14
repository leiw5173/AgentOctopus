#!/usr/bin/env node
/**
 * Build the skills index bundle for the GitHub Release.
 * Standalone ESM script — no workspace imports.
 *
 * Usage: node scripts/build-skills-index.js
 * Output: skills-index.json + skills-index.json.gz (in CWD)
 */
import { inflateRawSync, gzipSync } from 'zlib';
import fs from 'fs';
import path from 'path';

const CLAWHUB_BASE = 'https://clawhub.ai';
const AWESOME_README_URL =
  'https://raw.githubusercontent.com/VoltAgent/awesome-openclaw-skills/main/README.md';
const AWESOME_CATEGORY_BASE =
  'https://raw.githubusercontent.com/VoltAgent/awesome-openclaw-skills/main/categories/';
const DELAY_MS = 500;

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
      const wait = parseInt(res.headers.get('retry-after') ?? '5', 10) * 1000 + 1000;
      console.warn(`  Rate limited — waiting ${Math.ceil(wait / 1000)}s...`);
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
  const entries = parseZipEntries(zipBuffer);
  for (const entry of entries) {
    const basename = path.basename(entry.name);
    if (basename === targetName && !entry.isDirectory) {
      return entry.data.toString('utf8');
    }
  }
  return null;
}

async function fetchAwesomeSlugs() {
  const slugSet = new Set();
  const SKILL_URL_RE = /https:\/\/clawskills\.sh\/skills\/([\w.%-]+)/g;

  const parseMarkdown = (text) => {
    SKILL_URL_RE.lastIndex = 0;
    let m;
    while ((m = SKILL_URL_RE.exec(text)) !== null) {
      slugSet.add(m[1]);
    }
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

async function resolveSlug(ownerSlug) {
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
    if (res.ok) return candidate;
    if (res.status !== 404) return null;
  }
  return null;
}

async function main() {
  console.log('Fetching slug list from awesome-openclaw-skills...');
  const ownerSlugs = await fetchAwesomeSlugs();
  console.log(`Found ${ownerSlugs.length} slugs.`);

  const skills = [];
  let idx = 0;

  for (const ownerSlug of ownerSlugs) {
    idx++;
    process.stdout.write(`[${idx}/${ownerSlugs.length}] ${ownerSlug} ... `);

    const slug = await resolveSlug(ownerSlug);
    if (!slug) {
      console.log('SKIP (not found)');
      await sleep(DELAY_MS);
      continue;
    }

    const metaRes = await fetchWithRetry(`${CLAWHUB_BASE}/api/v1/skills/${encodeURIComponent(slug)}`);
    if (!metaRes.ok) {
      console.log(`SKIP (meta ${metaRes.status})`);
      await sleep(DELAY_MS);
      continue;
    }
    const meta = await metaRes.json();
    const version = meta.latestVersion?.version || meta.skill?.tags?.latest || 'latest';
    const author = meta.owner?.handle || meta.owner?.displayName || 'unknown';
    const name = meta.skill?.displayName || slug;
    const description = meta.skill?.summary || '';

    const zipUrl = `${CLAWHUB_BASE}/api/v1/download?slug=${encodeURIComponent(slug)}&version=${encodeURIComponent(version)}`;
    const zipRes = await fetchWithRetry(zipUrl);
    if (!zipRes.ok) {
      console.log(`SKIP (zip ${zipRes.status})`);
      await sleep(DELAY_MS);
      continue;
    }
    const zipBuffer = Buffer.from(await zipRes.arrayBuffer());

    const skillMd = extractFileFromZip(zipBuffer, 'SKILL.md');
    const metaJson = extractFileFromZip(zipBuffer, '_meta.json');
    const invokeScript = extractFileFromZip(zipBuffer, 'invoke.js');

    if (!skillMd) {
      console.log('SKIP (no SKILL.md in ZIP)');
      await sleep(DELAY_MS);
      continue;
    }

    skills.push({ slug, name, description, version, author, skillMd, metaJson, invokeScript });
    console.log('OK');
    await sleep(DELAY_MS);
  }

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
