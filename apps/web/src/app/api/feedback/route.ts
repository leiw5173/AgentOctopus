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
 * POST /api/feedback
 * Body: { skillName: string; positive: boolean; comment?: string; source?: string }
 */
export async function POST(req: Request) {
  try {
    const { skillName, positive, comment, source } = await req.json();

    if (!skillName || typeof positive !== 'boolean') {
      return NextResponse.json(
        { error: 'skillName (string) and positive (boolean) are required' },
        { status: 400 }
      );
    }

    await ensureLoaded();

    const skill = registry.getByName(skillName);
    if (!skill) {
      return NextResponse.json({ error: `Skill "${skillName}" not found` }, { status: 404 });
    }

    registry.recordFeedback(skillName, positive, comment, (source as 'cli' | 'web' | 'openclaw' | 'hermes' | 'other') ?? 'web');

    const updatedSkill = registry.getByName(skillName);
    return NextResponse.json({
      success: true,
      skillName,
      newRating: updatedSkill?.rating,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
