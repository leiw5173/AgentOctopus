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
import { inflateRawSync } from 'zlib';

const DEFAULT_REGISTRY = 'https://clawhub.ai';
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

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
 */
export async function fetchSkillMeta(slug: string, registryUrl?: string): Promise<ClaWHubSkillMeta> {
  const base = await resolveRegistry(registryUrl);
  const res = await fetchWithRetry(`${base}/api/v1/skills/${encodeURIComponent(slug)}`);
  if (!res.ok) {
    throw new Error(`Skill "${slug}" not found on ClaWHub (${res.status})`);
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
