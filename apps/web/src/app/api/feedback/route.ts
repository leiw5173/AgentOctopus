import { NextResponse } from 'next/server';
import { SkillRegistry } from '@octopus/registry';
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
 * Body: { skillName: string; positive: boolean; comment?: string }
 */
export async function POST(req: Request) {
  try {
    const { skillName, positive, comment } = await req.json();

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

    registry.recordFeedback(skillName, positive, comment);

    const updatedSkill = registry.getByName(skillName);
    return NextResponse.json({
      success: true,
      skillName,
      newRating: updatedSkill?.rating,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
