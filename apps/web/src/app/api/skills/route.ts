import { NextResponse } from 'next/server';
import { SkillRegistry } from '@agentoctopus/registry';
import path from 'path';

const registry = new SkillRegistry(
  path.resolve(process.cwd(), '../../registry/skills'),
  path.resolve(process.cwd(), '../../registry/ratings.json')
);

let loaded = false;

async function ensureLoaded() {
  if (!loaded) {
    await registry.load();
    loaded = true;
  }
}

/**
 * GET /api/skills — list all installed skills
 */
export async function GET() {
  try {
    await ensureLoaded();
    const skills = registry.getAll().map((s) => ({
      name: s.manifest.name,
      description: s.manifest.description,
      tags: s.manifest.tags,
      version: s.manifest.version,
      adapter: s.manifest.adapter,
      rating: s.rating,
      invocations: s.manifest.invocations,
      enabled: s.manifest.enabled,
    }));
    return NextResponse.json({ skills });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
