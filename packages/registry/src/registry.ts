import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { glob } from 'glob';
import { loadSkillsFromDir, type SkillEntry, type SkillSource, extractQueryTokens, scoreKeywordMatch } from '@agentoctopus/skills';
import { type SkillManifest, type SkillCredential } from './manifest-schema.js';
import { RatingStore } from './rating.js';
import type { TaskType } from './rating-dimensions.js';

/**
 * Transform a SkillEntry (from the skills package) into a LoadedSkill
 * that preserves backward compatibility with the existing manifest-based
 * types used by core, adapters, and CLI.
 */
function skillEntryToLoadedSkill(
  entry: SkillEntry,
  ratingStore: RatingStore,
): LoadedSkill {
  const fm = entry.frontmatter;
  // Map top-level `env` from community SKILL.md frontmatter to metadata.openclaw.env
  // so that getRequiredEnvVars() can detect them during the pre-flight credential check.
  // Community skills use `env: [- ZHIPU_API_KEY]` instead of `credentials:` or `metadata.openclaw.env:`.
  // Also handles `metadata.clawdbot.requires.env` (legacy format).
  const flatEnv = fm.env as string[] | undefined;
  const existingMetadata = fm.metadata as SkillManifest['metadata'] ?? {};
  const existingOpenclaw = existingMetadata.openclaw ?? {};
  const existingMetaEnv = existingOpenclaw.env;

  // Collect env vars from all sources: frontmatter `env`, clawdbot.requires.env
  const clawdbotEnv = (existingMetadata as Record<string, unknown>).clawdbot as Record<string, unknown> | undefined;
  const clawdbotRequires = clawdbotEnv?.requires as Record<string, unknown> | undefined;
  const clawdbotEnvVars = (clawdbotRequires?.env as string[] | undefined) ?? [];
  const allFlatEnv = [...(flatEnv ?? []), ...clawdbotEnvVars.filter(e => !(flatEnv ?? []).includes(e as string))];

  // Merge collected env vars into metadata.openclaw.env
  let mergedEnv: string[] | undefined;
  if (allFlatEnv.length > 0) {
    if (Array.isArray(existingMetaEnv)) {
      const combined = [...allFlatEnv, ...existingMetaEnv.filter(e => !allFlatEnv.includes(e as string))];
      mergedEnv = combined;
    } else if (existingMetaEnv && typeof existingMetaEnv === 'object') {
      // Object format: merge flat keys into required array
      const obj = existingMetaEnv as { required?: { name?: string; label?: string }[]; optional?: { name?: string; label?: string }[] };
      const existingRequiredNames = (obj.required ?? []).map(e => e.name).filter(Boolean) as string[];
      const additionalRequired = allFlatEnv.filter(k => !existingRequiredNames.includes(k)).map(k => ({ name: k }));
      mergedEnv = undefined; // keep object format
      const mergedObj = {
        ...obj,
        required: [...(obj.required ?? []), ...additionalRequired],
      };
      (existingOpenclaw as Record<string, unknown>).env = mergedObj;
    } else {
      mergedEnv = allFlatEnv;
    }
  }

  if (mergedEnv) {
    (existingOpenclaw as Record<string, unknown>).env = mergedEnv;
  }

  const metadata: SkillManifest['metadata'] = {
    ...existingMetadata,
    openclaw: existingOpenclaw,
  };

  const manifest: SkillManifest = {
    name: entry.skill.name,
    description: entry.skill.description,
    tags: (entry.skill.tags?.length ?? 0) > 0 ? entry.skill.tags : (Array.isArray(fm.tags) ? (fm.tags as string[]) : []),
    version: entry.skill.version,
    adapter: (fm.adapter as SkillManifest['adapter']) ?? 'http',
    hosting: (fm.hosting as SkillManifest['hosting']) ?? 'cloud',
    auth: (fm.auth as SkillManifest['auth']) ?? 'none',
    endpoint: fm.endpoint as string | undefined,
    input_schema: fm.input_schema as Record<string, string> | undefined,
    output_schema: fm.output_schema as Record<string, string> | undefined,
    rating: (fm.rating as number) ?? 3.0,
    invocations: (fm.invocations as number) ?? 0,
    enabled: (fm.enabled as boolean) ?? true,
    taskType: (fm.taskType as 'one-shot' | 'long-running' | 'agent-collab' | undefined) ?? 'one-shot',
    latencyTarget: fm.latencyTarget as number | undefined,
    tokenCostTarget: fm.tokenCostTarget as number | undefined,
    llm_powered: (fm.llm_powered as boolean) ?? false,
    credentials: fm.credentials as SkillCredential[] | undefined,
    metadata,
    sandbox: fm.sandbox as SkillManifest["sandbox"] ?? undefined,
    compose: fm.compose as SkillManifest["compose"] ?? undefined,
  };

  // Merge persisted rating and invocation count over manifest defaults
  const persistedEntry = ratingStore.getAll()[manifest.name];
  if (persistedEntry !== undefined) {
    manifest.rating = persistedEntry.dimensions.quality;
    manifest.invocations = persistedEntry.invocations;
  }

  return {
    manifest,
    dirPath: entry.skill.dirPath,
    rating: manifest.rating,
    routingScore: ratingStore.getRoutingScore(manifest.name, manifest.taskType),
    negativeFeedbackCount: ratingStore.getOrCreate(manifest.name).recentFeedback.filter(f => !f.positive).length,
    entry,
  };
}

export interface LoadedSkill {
  manifest: SkillManifest;
  dirPath: string;
  rating: number;
  routingScore?: number;
  negativeFeedbackCount?: number;
  /** Original SkillEntry parsed from @agentoctopus/skills — may be missing for cache-restored skills. */
  entry?: SkillEntry;
}

/**
 * Return the original SkillEntry for a LoadedSkill.
 * If the skill was restored from cache (entry missing), build a minimal
 * fallback from the manifest so downstream consumers never crash.
 */
export function getSkillEntry(skill: LoadedSkill): SkillEntry {
  if (skill.entry) return skill.entry;

  const rawMeta = (skill.manifest.metadata ?? {}) as Record<string, unknown>;
  const openclaw = (rawMeta.openclaw ?? {}) as Record<string, unknown>;

  // Lazily read instructions from disk when the original SkillEntry is missing
  // (e.g. skill was restored from cache). This prevents downstream consumers
  // like SubprocessAdapter from failing to locate scripts.
  let lazyInstructions = '';
  try {
    const skillMdPath = path.join(skill.dirPath, 'SKILL.md');
    if (fs.existsSync(skillMdPath)) {
      const raw = fs.readFileSync(skillMdPath, 'utf-8');
      const match = raw.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
      lazyInstructions = (match ? match[1] : raw).trim();
    }
  } catch {
    // Keep empty on read failure — downstream already handles missing instructions
  }

  return {
    skill: {
      name: skill.manifest.name,
      description: skill.manifest.description,
      version: skill.manifest.version,
      dirPath: skill.dirPath,
      source: ((rawMeta.source as string) ?? (openclaw ? 'clawhub' : 'user')) as SkillSource,
      tags: skill.manifest.tags,
      instructions: lazyInstructions,
      frontmatter: {},
    },
    frontmatter: skill.manifest.metadata ?? {},
    metadata: {
      skillKey: (openclaw.skillKey as string) ?? skill.manifest.name,
      always: (rawMeta.always as boolean) ?? undefined,
      os: (rawMeta.os as string[]) ?? undefined,
      requires: (rawMeta.requires as any) ?? undefined,
      primaryEnv: (rawMeta.primaryEnv as string) ?? (openclaw.primaryEnv as string) ?? undefined,
      install: (rawMeta.install as any[]) ?? (openclaw.install as any[]) ?? undefined,
    },
    invocation: { userInvocable: true, disableModelInvocation: false },
  };
}

export class SkillRegistry {
  private skills: Map<string, LoadedSkill> = new Map();
  private ratingStore: RatingStore;
  public noCache = false;

  constructor(
    private skillsDir: string,
    ratingsPath: string,
  ) {
    this.ratingStore = new RatingStore(ratingsPath);
  }

  /**
   * Load additional skills from a second directory, merging into the existing registry.
   * Skills from `extraDir` take priority — they overwrite any same-named skill already loaded.
   */
  async loadFrom(extraDir: string): Promise<void> {
    const entries = await loadSkillsFromDir(extraDir, 'user');

    for (const entry of entries) {
      const loaded = skillEntryToLoadedSkill(entry, this.ratingStore);
      this.skills.set(loaded.manifest.name, loaded);
    }
  }

  private cachePath(): string {
    return path.join(this.skillsDir, '.registry-cache.json');
  }

  private computeFilesHash(files: string[]): string {
    const sorted = [...files].sort();
    const mtimes = sorted.map(f => {
      try { return `${f}:${fs.statSync(f).mtimeMs}`; }
      catch { return `${f}:0`; }
    }).join('|');
    return createHash('sha1').update(mtimes).digest('hex').slice(0, 16);
  }

  async load(): Promise<void> {
    // glob requires forward slashes on all platforms (including Windows)
    const pattern = this.skillsDir.replace(/\\/g, '/') + '/**/SKILL.md';
    const files = await glob(pattern);

    // Check file-based cache
    if (!this.noCache) {
      const hash = this.computeFilesHash(files);
      try {
        const cacheRaw = fs.readFileSync(this.cachePath(), 'utf-8');
        const cache = JSON.parse(cacheRaw);
        if (cache.hash === hash && Array.isArray(cache.skills)) {
          let restored = 0;
          for (const s of cache.skills) {
            try {
              // Validate the cached manifest still has required fields
              if (!s.manifest?.name || !s.manifest?.description || !s.dirPath) continue;
              const manifest = s.manifest as SkillManifest;
              const persistedEntry = this.ratingStore.getAll()[manifest.name];
              if (persistedEntry !== undefined) {
                manifest.rating = persistedEntry.dimensions.quality;
                manifest.invocations = persistedEntry.invocations;
              }
              this.skills.set(manifest.name, {
                manifest,
                dirPath: s.dirPath,
                rating: manifest.rating,
                routingScore: this.ratingStore.getRoutingScore(manifest.name, manifest.taskType),
                entry: s.entry,
              });
              restored++;
            } catch { /* skip corrupt entries */ }
          }
          if (restored > 0) return; // Cache hit
        }
      } catch { /* cache miss or corrupt — proceed with full load */ }
    }

    // Delegate SKILL.md discovery and parsing to the @agentoctopus/skills package
    const entries = await loadSkillsFromDir(this.skillsDir, 'clawhub', { maxCandidates: Infinity });
    let failCount = 0;
    for (const entry of entries) {
      try {
        const loaded = skillEntryToLoadedSkill(entry, this.ratingStore);
        this.skills.set(loaded.manifest.name, loaded);
      } catch {
        failCount++;
      }
    }

    if (failCount > 0) {
      const total = entries.length;
      process.stderr.write(
        `[Registry] Loaded ${total - failCount}/${total} skills (${failCount} skipped — incompatible format)\n`
      );
    }

    // Write cache
    try {
      const hash = this.computeFilesHash(files);
      const serialized = Array.from(this.skills.values()).map(s => ({
        manifest: s.manifest,
        dirPath: s.dirPath,
        entry: s.entry,
      }));
      fs.writeFileSync(this.cachePath(), JSON.stringify({ hash, skills: serialized }));
    } catch { /* cache write failure is non-fatal */ }
  }

  getAll(): LoadedSkill[] {
    return Array.from(this.skills.values()).filter((s) => s.manifest.enabled);
  }

  getByName(name: string): LoadedSkill | undefined {
    return this.skills.get(name);
  }

  /**
   * Lazily read the SKILL.md body (instructions) from disk for a selected skill.
   * Called at execution time, not at registry load time.
   */
  readInstructions(skill: LoadedSkill): string {
    const skillMdPath = path.join(skill.dirPath, 'SKILL.md');
    const raw = fs.readFileSync(skillMdPath, 'utf-8');
    const match = raw.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
    return (match ? match[1] : raw).trim();
  }

  search(query: string): LoadedSkill[] {
    const tokens = extractQueryTokens(query);
    if (tokens.length === 0) return [];
    return this.getAll()
      .map((s) => ({
        skill: s,
        score: scoreKeywordMatch(tokens, {
          name: s.manifest.name,
          description: s.manifest.description,
          tags: s.manifest.tags,
        }),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ skill }) => skill);
  }

  recordInvocation(skillName: string): void {
    this.ratingStore.recordInvocation(skillName);
    const skill = this.skills.get(skillName);
    if (skill) {
      skill.manifest.invocations++;
    }
  }

  recordFeedback(
    skillName: string,
    positive: boolean,
    comment?: string,
    source: 'cli' | 'web' | 'openclaw' | 'hermes' | 'other' = 'other',
    taskType?: TaskType,
  ): void {
    this.ratingStore.recordFeedback(skillName, positive, comment, source, taskType);
    const skill = this.skills.get(skillName);
    if (skill) {
      const updatedRating = this.ratingStore.getRating(skillName);
      if (updatedRating !== undefined) {
        skill.rating = updatedRating;
        skill.manifest.rating = skill.rating;
      }
      skill.routingScore = this.ratingStore.getRoutingScore(skillName, skill.manifest.taskType);
      skill.negativeFeedbackCount = this.ratingStore.getOrCreate(skillName).recentFeedback.filter(f => !f.positive).length;
    }
  }

  recordInvocationMetrics(
    skillName: string,
    opts: { success: boolean; latencyMs: number; tokenUsage: number },
  ): void {
    this.ratingStore.recordInvocationMetrics(skillName, opts);
    const skill = this.skills.get(skillName);
    if (skill) {
      skill.manifest.invocations = this.ratingStore.getOrCreate(skillName).invocations;
      skill.routingScore = this.ratingStore.getRoutingScore(skillName, skill.manifest.taskType);
    }
  }

  getRoutingScore(skillName: string, taskType: TaskType = 'one-shot'): number {
    return this.ratingStore.getRoutingScore(skillName, taskType);
  }

  /**
   * Read raw SKILL.md and script files for a skill, used by the export endpoint.
   */
  getSkillFiles(skillName: string): { skillMd: string; scripts: Record<string, string> } | undefined {
    const skill = this.skills.get(skillName);
    if (!skill) return undefined;

    const skillMd = fs.readFileSync(path.join(skill.dirPath, 'SKILL.md'), 'utf-8');
    const scripts: Record<string, string> = {};

    const scriptsDir = path.join(skill.dirPath, 'scripts');
    if (fs.existsSync(scriptsDir)) {
      for (const file of fs.readdirSync(scriptsDir)) {
        const filePath = path.join(scriptsDir, file);
        if (fs.statSync(filePath).isFile()) {
          scripts[file] = fs.readFileSync(filePath, 'utf-8');
        }
      }
    }

    return { skillMd, scripts };
  }

  /** Expose the underlying RatingStore for direct access (used by gateway feedback endpoints). */
  getRatingStore(): RatingStore {
    return this.ratingStore;
  }
}
