/**
 * ClaWHub client — fetch and install skills from clawhub.ai registry.
 *
 * Uses the ClaWHub v1 API:
 *   GET  /api/v1/skills/:slug     — skill metadata
 *   GET  /api/v1/download?slug=X&version=Y — download ZIP
 *   GET  /api/v1/search?q=...     — search skills
 */

import fs from 'fs';
import path from 'path';
import { inflateRawSync, gunzipSync } from 'zlib';

const DEFAULT_REGISTRY = 'https://clawhub.ai';
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;
const AWESOME_README_URL =
  'https://raw.githubusercontent.com/VoltAgent/awesome-openclaw-skills/main/README.md';
const AWESOME_CATEGORY_BASE =
  'https://raw.githubusercontent.com/VoltAgent/awesome-openclaw-skills/main/categories/';

// Fixed URL for the pre-built daily index published to GitHub Releases.
export const SKILLS_INDEX_URL =
  'https://github.com/leiw5173/AgentOctopus/releases/download/skills-index-latest/skills-index.json.gz';

// ── Skills Index types ────────────────────────────────────────────────────────

export interface SkillIndexEntry {
  slug: string;
  name: string;
  description: string;
  version: string;
  author: string;
  /** Full content of SKILL.md */
  skillMd: string | null;
  /** Full content of _meta.json */
  metaJson: string | null;
  /** Full content of scripts/invoke.js, or null when absent */
  invokeScript: string | null;
}

interface SkillsIndex {
  version: string;
  builtAt: string;
  skills: SkillIndexEntry[];
}



// --- Types matching the actual ClaWHub v1 API response ---

interface ClaWHubApiSkillResponse {
  skill: {
    slug: string;
    displayName: string;
    summary: string;
    tags: Record<string, string>; // e.g. { latest: "1.0.0" }
    stats: {
      comments: number;
      downloads: number;
      installsAllTime: number;
      installsCurrent: number;
      stars: number;
      versions: number;
    };
  };
  latestVersion: {
    version: string;
    createdAt: number;
    changelog: string;
    license: string | null;
  };
  owner: {
    handle: string;
    displayName: string;
  };
  moderation: {
    isMalwareBlocked?: boolean;
    isSuspicious?: boolean;
  } | null;
}

// Normalized metadata returned to callers
export interface ClaWHubSkillMeta {
  slug: string;
  name: string;
  description: string;
  version: string;
  author: string;
  license: string;
  downloads: number;
  stars: number;
  isMalwareBlocked: boolean;
  isSuspicious: boolean;
}

export interface ClaWHubSearchResult {
  slug: string;
  name: string;
  description: string;
  version: string;
  author: string;
  stars: number;
}

/**
 * Fetch with retry on 429 (rate limit) and 5xx errors.
 * Respects the retry-after header from ClaWHub.
 */
async function fetchWithRetry(url: string, retries = MAX_RETRIES): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url);
    if (res.status === 429 && attempt < retries) {
      const retryAfter = res.headers.get('retry-after');
      const waitMs = retryAfter
        ? (parseInt(retryAfter, 10) + 1) * 1000  // respect server's retry-after + 1s buffer
        : RETRY_BASE_MS * Math.pow(2, attempt);
      const waitSec = Math.ceil(waitMs / 1000);
      process.stderr.write(`  Rate limited — waiting ${waitSec}s before retry (${attempt + 1}/${retries})...\n`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (res.status >= 500 && attempt < retries) {
      const waitMs = RETRY_BASE_MS * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    return res;
  }
  throw new Error('Fetch retry exhausted');
}

/**
 * Discover the API base URL from a registry's well-known endpoint.
 */
async function resolveRegistry(registryUrl?: string): Promise<string> {
  const base = registryUrl || DEFAULT_REGISTRY;
  try {
    const res = await fetch(`${base}/.well-known/clawhub.json`);
    if (res.ok) {
      const config = (await res.json()) as { apiBase?: string };
      return config.apiBase || base;
    }
  } catch {
    // fall through
  }
  return base;
}

/**
 * Fetch skill metadata from ClaWHub and normalize the response.
 *
 * awesome-openclaw-skills URLs use `{owner}-{slug}` format, but ClaWHub API
 * only knows the `{slug}` part. If the full string returns 404, progressively
 * strip leading `{segment}-` prefixes until we get a hit or exhaust candidates.
 */
export async function fetchSkillMeta(slug: string, registryUrl?: string): Promise<ClaWHubSkillMeta> {
  const base = await resolveRegistry(registryUrl);

  // Build candidate list: [original, strip-1-prefix, strip-2-prefix, ...]
  const candidates: string[] = [slug];
  let remainder = slug;
  while (remainder.includes('-')) {
    remainder = remainder.slice(remainder.indexOf('-') + 1);
    candidates.push(remainder);
  }

  let res: Response | undefined;
  let resolvedSlug = slug;
  for (const candidate of candidates) {
    res = await fetchWithRetry(`${base}/api/v1/skills/${encodeURIComponent(candidate)}`);
    if (res.ok) { resolvedSlug = candidate; break; }
    if (res.status !== 404) break; // non-404 error — don't keep trying
  }

  if (!res || !res.ok) {
    throw new Error(`Skill "${slug}" not found on ClaWHub (${res?.status ?? 'unknown'})`);
  }

  const data = (await res.json()) as ClaWHubApiSkillResponse;
  const { skill, latestVersion, owner, moderation } = data;

  return {
    slug: skill.slug,
    name: skill.displayName || skill.slug,
    description: skill.summary || '',
    version: latestVersion?.version || skill.tags?.latest || 'latest',
    author: owner?.handle || owner?.displayName || 'unknown',
    license: latestVersion?.license || '',
    downloads: skill.stats?.downloads || 0,
    stars: skill.stats?.stars || 0,
    isMalwareBlocked: moderation?.isMalwareBlocked || false,
    isSuspicious: moderation?.isSuspicious || false,
  };
}

/**
 * Search ClaWHub for skills matching a query.
 */
export async function searchSkills(query: string, registryUrl?: string): Promise<ClaWHubSearchResult[]> {
  const base = await resolveRegistry(registryUrl);
  const res = await fetchWithRetry(`${base}/api/v1/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) {
    throw new Error(`ClaWHub search failed (${res.status})`);
  }
  const data = await res.json();

  // Normalize the response — API may return various shapes
  const items: any[] = Array.isArray(data)
    ? data
    : (data as any).results || (data as any).skills || [];

  return items.map((item: any) => ({
    slug: item.slug || item.name || '',
    name: item.displayName || item.name || item.slug || '',
    description: item.summary || item.description || '',
    version: item.latestVersion?.version || item.version || item.tags?.latest || '',
    author: item.owner?.handle || item.author || '',
    stars: item.stats?.stars || item.stars || 0,
  }));
}

/**
 * Download and extract a skill ZIP from ClaWHub into the local registry.
 * Returns the path to the installed skill directory.
 */
export async function installSkill(
  slug: string,
  targetDir: string,
  options?: { version?: string; registryUrl?: string; force?: boolean },
): Promise<string> {
  const base = await resolveRegistry(options?.registryUrl);

  // 1. Fetch metadata to validate and get latest version
  const meta = await fetchSkillMeta(slug, options?.registryUrl);

  if (meta.isMalwareBlocked) {
    throw new Error(`Skill "${slug}" has been flagged as malware and cannot be installed.`);
  }

  const version = options?.version || meta.version;
  const skillDir = path.join(targetDir, meta.slug || slug);

  // 2. Check if already installed
  if (fs.existsSync(skillDir) && !options?.force) {
    throw new Error(`Skill "${slug}" already exists at ${skillDir}. Use --force to overwrite.`);
  }

  // 3. Download the skill ZIP
  const downloadUrl = `${base}/api/v1/download?slug=${encodeURIComponent(meta.slug || slug)}&version=${encodeURIComponent(version)}`;
  const res = await fetchWithRetry(downloadUrl);
  if (!res.ok) {
    throw new Error(`Failed to download skill "${slug}" v${version} (${res.status})`);
  }

  // 4. Extract the ZIP
  const zipBuffer = Buffer.from(await res.arrayBuffer());

  // Remove existing dir if force
  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true });
  }
  fs.mkdirSync(skillDir, { recursive: true });

  extractZip(zipBuffer, skillDir);

  // 5. Write origin metadata
  const originFile = path.join(skillDir, '.clawhub-origin.json');
  fs.writeFileSync(
    originFile,
    JSON.stringify(
      {
        version: 1,
        registry: base,
        slug: meta.slug,
        installedVersion: version,
        installedAt: Date.now(),
        author: meta.author,
      },
      null,
      2,
    ),
  );

  return skillDir;
}

/**
 * Minimal ZIP extractor using Node built-ins.
 */
function extractZip(zipBuffer: Buffer, targetDir: string): void {
  const entries = parseZipEntries(zipBuffer);

  for (const entry of entries) {
    // Sanitize path — prevent directory traversal
    const safeName = entry.name.replace(/\.\.\//g, '').replace(/\.\.\\/g, '');
    if (!safeName || safeName.startsWith('/')) continue;

    const fullPath = path.join(targetDir, safeName);

    if (entry.isDirectory) {
      fs.mkdirSync(fullPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, entry.data);
    }
  }
}

interface ZipEntry {
  name: string;
  isDirectory: boolean;
  data: Buffer;
}

function parseZipEntries(buffer: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;

  while (offset < buffer.length - 4) {
    const sig = buffer.readUInt32LE(offset);

    // Local file header signature
    if (sig !== 0x04034b50) break;

    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);

    const nameStart = offset + 30;
    const name = buffer.toString('utf8', nameStart, nameStart + nameLength);
    const dataStart = nameStart + nameLength + extraLength;
    const isDirectory = name.endsWith('/');

    let data: Buffer;
    if (compressionMethod === 0) {
      // Stored (no compression)
      data = buffer.subarray(dataStart, dataStart + compressedSize);
    } else if (compressionMethod === 8) {
      // Deflate
      data = inflateRawSync(buffer.subarray(dataStart, dataStart + compressedSize));
    } else {
      // Skip unsupported compression
      offset = dataStart + compressedSize;
      continue;
    }

    entries.push({ name, isDirectory, data });
    offset = dataStart + compressedSize;
  }

  return entries;
}

/**
 * Fetch skill slugs from the awesome-openclaw-skills GitHub repository.
 *
 * Parses `clawskills.sh/skills/<slug>` URLs from markdown files.
 * - No options → fetches README to discover category files, then fetches each one.
 * - category provided → fetches that single category file only.
 * - rawUrl provided → fetches that URL directly (used in tests).
 */
export async function fetchAwesomeSlugs(options?: {
  category?: string;
  rawUrl?: string;
}): Promise<string[]> {
  const slugSet = new Set<string>();
  const SKILL_URL_RE = /https:\/\/clawskills\.sh\/skills\/([\w.%-]+)/g;

  const parseMarkdown = (text: string): void => {
    SKILL_URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SKILL_URL_RE.exec(text)) !== null) {
      slugSet.add(m[1]);
    }
  };

  if (options?.rawUrl) {
    const res = await fetchWithRetry(options.rawUrl);
    if (!res.ok) throw new Error(`Failed to fetch ${options.rawUrl} (${res.status})`);
    parseMarkdown(await res.text());
  } else if (options?.category) {
    // Normalise category name to kebab-case filename
    const filename =
      options.category.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '.md';
    const url = `${AWESOME_CATEGORY_BASE}${filename}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) {
      throw new Error(
        `Category "${options.category}" not found (${res.status}). ` +
        `Check https://github.com/VoltAgent/awesome-openclaw-skills/tree/main/categories for valid names.`,
      );
    }
    parseMarkdown(await res.text());
  } else {
    // Fetch README to discover category file names, then fetch each category
    const readmeRes = await fetchWithRetry(AWESOME_README_URL);
    if (!readmeRes.ok) {
      throw new Error(`Failed to fetch awesome-openclaw-skills README (${readmeRes.status})`);
    }
    const readme = await readmeRes.text();

    // Extract category filenames linked in the README, e.g. categories/git-and-github.md
    const catRe = /categories\/([\w-]+\.md)/g;
    const catFiles: string[] = [];
    let cm: RegExpExecArray | null;
    while ((cm = catRe.exec(readme)) !== null) {
      if (!catFiles.includes(cm[1])) catFiles.push(cm[1]);
    }

    if (catFiles.length === 0) {
      // README doesn't list categories explicitly — parse slugs from the README itself
      parseMarkdown(readme);
    } else {
      for (const file of catFiles) {
        const res = await fetchWithRetry(`${AWESOME_CATEGORY_BASE}${file}`);
        if (res.ok) parseMarkdown(await res.text());
        // Silently skip category files that 404 — list may evolve
      }
    }
  }

  return Array.from(slugSet);
}

/**
 * Download, decompress, and parse the pre-built skills index from GitHub Releases.
 *
 * @param url  Override the default SKILLS_INDEX_URL (useful for testing).
 * @returns    Array of SkillIndexEntry objects from the index.
 * @throws     Error on network failure, non-200 response, or malformed JSON.
 */
export async function downloadSkillsIndex(url?: string): Promise<SkillIndexEntry[]> {
  const target = url ?? SKILLS_INDEX_URL;
  const res = await fetch(target);

  if (!res.ok) {
    throw new Error(`Failed to download skills index (${res.status}) from ${target}`);
  }

  const compressed = Buffer.from(await res.arrayBuffer());
  const json = gunzipSync(compressed).toString('utf8');
  const index = JSON.parse(json) as SkillsIndex;

  if (!Array.isArray(index.skills)) {
    throw new Error('Skills index is malformed: "skills" is not an array');
  }

  return index.skills;
}

/**
 * Write a single SkillIndexEntry to disk as a local skill directory.
 *
 * Creates:
 *   <skillsDir>/<slug>/SKILL.md
 *   <skillsDir>/<slug>/_meta.json
 *   <skillsDir>/<slug>/scripts/invoke.js  (only when invokeScript is non-null)
 *
 * Silently skips if the skill directory already exists and `force` is false.
 */
export function installFromIndex(
  entry: SkillIndexEntry,
  skillsDir: string,
  force = false,
): void {
  const skillDir = path.join(skillsDir, entry.slug);

  if (fs.existsSync(skillDir) && !force) return;

  // Remove stale directory when force is set
  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true });
  }

  fs.mkdirSync(skillDir, { recursive: true });
  if (!entry.skillMd) throw new Error(`Skill "${entry.slug}" has no SKILL.md content in the index`);
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), entry.skillMd, 'utf8');
  fs.writeFileSync(path.join(skillDir, '_meta.json'), entry.metaJson ?? '', 'utf8');

  if (entry.invokeScript !== null) {
    const scriptsDir = path.join(skillDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'invoke.js'), entry.invokeScript, 'utf8');
  }
}
