import { NextResponse } from 'next/server';
import type { SkillRegistry } from '@agentoctopus/registry';
import { createConfiguredRegistry } from '../registry-config';

let loaded = false;
let registry: SkillRegistry;

async function ensureLoaded() {
  if (!loaded) {
    registry = createConfiguredRegistry();
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
