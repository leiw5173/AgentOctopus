import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const MARKETPLACE_DIR = path.resolve(process.cwd(), '../../registry/marketplace');
const SKILLS_DIR = path.resolve(process.cwd(), '../../registry/skills');
const MARKETPLACE_INDEX = path.join(MARKETPLACE_DIR, 'index.json');

/**
 * POST /api/marketplace/install
 * Body: { slug: string }
 * Copies a skill from the marketplace into the local registry.
 */
export async function POST(req: Request) {
  try {
    const { slug } = await req.json();
    if (!slug) {
      return NextResponse.json({ error: 'slug is required' }, { status: 400 });
    }

    const sourceDir = path.join(MARKETPLACE_DIR, 'skills', slug);
    if (!fs.existsSync(sourceDir)) {
      return NextResponse.json({ error: `Skill "${slug}" not found in marketplace` }, { status: 404 });
    }

    // Copy to local registry
    const targetDir = path.join(SKILLS_DIR, slug);
    fs.mkdirSync(targetDir, { recursive: true });

    const files = fs.readdirSync(sourceDir);
    for (const file of files) {
      const src = path.join(sourceDir, file);
      const dest = path.join(targetDir, file);
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, dest);
      }
    }

    // Increment download count
    if (fs.existsSync(MARKETPLACE_INDEX)) {
      const index = JSON.parse(fs.readFileSync(MARKETPLACE_INDEX, 'utf8'));
      const entry = index.find((s: any) => s.slug === slug);
      if (entry) {
        entry.downloads = (entry.downloads || 0) + 1;
        fs.writeFileSync(MARKETPLACE_INDEX, JSON.stringify(index, null, 2));
      }
    }

    return NextResponse.json({
      success: true,
      message: `Skill "${slug}" installed to ${targetDir}. Restart the server to activate.`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
