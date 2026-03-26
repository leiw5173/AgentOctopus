import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const MARKETPLACE_DIR = path.resolve(process.cwd(), '../../registry/marketplace');
const MARKETPLACE_INDEX = path.join(MARKETPLACE_DIR, 'index.json');

export interface MarketplaceSkill {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  version: string;
  author: string;
  adapter: string;
  downloads: number;
  rating: number;
  publishedAt: string;
}

function ensureMarketplace() {
  if (!fs.existsSync(MARKETPLACE_DIR)) {
    fs.mkdirSync(MARKETPLACE_DIR, { recursive: true });
  }
  if (!fs.existsSync(MARKETPLACE_INDEX)) {
    fs.writeFileSync(MARKETPLACE_INDEX, '[]');
  }
}

function readIndex(): MarketplaceSkill[] {
  ensureMarketplace();
  return JSON.parse(fs.readFileSync(MARKETPLACE_INDEX, 'utf8'));
}

function writeIndex(skills: MarketplaceSkill[]) {
  ensureMarketplace();
  fs.writeFileSync(MARKETPLACE_INDEX, JSON.stringify(skills, null, 2));
}

/**
 * GET /api/marketplace?q=search&tag=filter
 * List/search marketplace skills
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const query = url.searchParams.get('q')?.toLowerCase() || '';
    const tag = url.searchParams.get('tag')?.toLowerCase() || '';

    let skills = readIndex();

    if (query) {
      skills = skills.filter(
        (s) =>
          s.name.toLowerCase().includes(query) ||
          s.description.toLowerCase().includes(query) ||
          s.slug.toLowerCase().includes(query),
      );
    }

    if (tag) {
      skills = skills.filter((s) =>
        s.tags.some((t) => t.toLowerCase() === tag),
      );
    }

    // Sort by downloads desc
    skills.sort((a, b) => b.downloads - a.downloads);

    return NextResponse.json({ skills, total: skills.length });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * POST /api/marketplace — publish a new skill
 * Body: { slug, name, description, tags, version, author, adapter }
 * Also expects the skill files to be uploaded as a ZIP or the SKILL.md content
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { slug, name, description, tags, version, author, adapter, skillMd } = body;

    if (!slug || !name || !description) {
      return NextResponse.json(
        { error: 'slug, name, and description are required' },
        { status: 400 },
      );
    }

    // Validate slug format
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug) && !/^[a-z0-9]$/.test(slug)) {
      return NextResponse.json(
        { error: 'slug must be lowercase alphanumeric with hyphens (e.g. my-skill)' },
        { status: 400 },
      );
    }

    const index = readIndex();

    // Check for duplicate
    const existing = index.findIndex((s) => s.slug === slug);

    const entry: MarketplaceSkill = {
      slug,
      name,
      description,
      tags: tags || [],
      version: version || '1.0.0',
      author: author || 'anonymous',
      adapter: adapter || 'subprocess',
      downloads: existing >= 0 ? index[existing]!.downloads : 0,
      rating: existing >= 0 ? index[existing]!.rating : 3.0,
      publishedAt: new Date().toISOString(),
    };

    // Store skill files
    const skillDir = path.join(MARKETPLACE_DIR, 'skills', slug);
    fs.mkdirSync(skillDir, { recursive: true });

    if (skillMd) {
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMd);
    }

    // Store metadata
    fs.writeFileSync(
      path.join(skillDir, 'metadata.json'),
      JSON.stringify(entry, null, 2),
    );

    // Update index
    if (existing >= 0) {
      index[existing] = entry;
    } else {
      index.push(entry);
    }
    writeIndex(index);

    return NextResponse.json({ success: true, skill: entry });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
