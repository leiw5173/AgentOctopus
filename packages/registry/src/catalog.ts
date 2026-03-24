/**
 * MCP Catalog Discovery
 *
 * Fetches a remote MCP skill catalog JSON and merges it into the local registry.
 * The catalog endpoint should return an array of CatalogEntry objects.
 *
 * Example catalog JSON:
 * [
 *   {
 *     "name": "web-search",
 *     "description": "Search the web for information.",
 *     "tags": ["search", "web"],
 *     "version": "1.0.0",
 *     "adapter": "mcp",
 *     "endpoint": "npx @example/web-search-mcp",
 *     "rating": 4.2
 *   }
 * ]
 */

import { SkillManifestSchema, type SkillManifest } from './manifest-schema.js';

export interface CatalogEntry {
  name: string;
  description: string;
  tags: string[];
  version: string;
  adapter: string;
  endpoint?: string;
  rating?: number;
}

export interface LoadedCatalogSkill {
  manifest: SkillManifest;
  instructions: string;
  dirPath: string;
  rating: number;
  remote: true;
}

/**
 * Fetches a JSON catalog from a URL and returns parsed LoadedCatalogSkill entries.
 * Invalid entries are skipped with a warning.
 */
export async function fetchRemoteCatalog(url: string): Promise<LoadedCatalogSkill[]> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch MCP catalog from ${url}: ${res.status} ${res.statusText}`);
  }

  const entries = (await res.json()) as CatalogEntry[];
  const skills: LoadedCatalogSkill[] = [];

  for (const entry of entries) {
    try {
      const manifest = SkillManifestSchema.parse({
        ...entry,
        hosting: 'cloud',
        auth: 'none',
        invocations: 0,
        enabled: true,
        llm_powered: false,
      });

      skills.push({
        manifest,
        instructions: entry.endpoint || '',
        dirPath: '',
        rating: entry.rating ?? manifest.rating,
        remote: true,
      });
    } catch (err) {
      console.warn(`[Catalog] Skipping invalid entry "${entry.name}": ${err}`);
    }
  }

  return skills;
}
