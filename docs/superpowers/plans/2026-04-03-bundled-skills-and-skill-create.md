# Bundled Skills & `octopus skill create` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship built-in skills with the npm CLI package, store them in a user-controlled home directory (`~/.agentoctopus/`), prompt for API key credentials during onboarding, and add `octopus skill create` with an AI-assisted wizard and `--template` fallback.

**Architecture:** Bundled skills live in `apps/cli/skills/` and are copied to the user's chosen directory during onboarding. A new `apps/cli/src/config.ts` module owns reading/writing `~/.agentoctopus/octopus.json`. The `skill` subcommand group reorganizes existing skill commands and adds `create`. The `SkillManifestSchema` gains a `credentials` field used by both the registry and onboarding.

**Tech Stack:** TypeScript, Node.js, Commander.js, `@inquirer/prompts`, `gray-matter`, `zod`, `@agentoctopus/core` LLM client (for AI-assisted `skill create`)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `packages/registry/src/manifest-schema.ts` | Modify | Add `credentials` field to `SkillManifestSchema` |
| `packages/registry/tests/manifest-schema.test.ts` | Modify | Test `credentials` field parsing |
| `apps/cli/skills/` | Create | Copy of `registry/skills/` — shipped in npm package |
| `apps/cli/package.json` | Modify | Add `"skills"` to `"files"` array |
| `apps/cli/src/config.ts` | Create | `loadOctopusConfig()`, `saveOctopusConfig()`, `OctopusConfig` type |
| `apps/cli/src/onboard.ts` | Modify | Add Step 0 (skills dir + bundled copy), credential prompting in skill selection |
| `apps/cli/src/index.ts` | Modify | Add `skill` subcommand group; wire `create`, keep backwards-compat aliases |
| `apps/cli/src/skill-create.ts` | Create | `runSkillCreateWizard()` — AI wizard + `--template` scaffold |
| `registry/skills/x-search/SKILL.md` | Modify | Add `credentials` frontmatter for `XAI_API_KEY` |

---

## Task 1: Extend `SkillManifestSchema` with `credentials`

**Files:**
- Modify: `packages/registry/src/manifest-schema.ts`
- Modify: `packages/registry/tests/manifest-schema.test.ts`

- [ ] **Step 1: Write a failing test for `credentials` field parsing**

Add to `packages/registry/tests/manifest-schema.test.ts`:

```ts
it('parses credentials field', () => {
  const raw = {
    name: 'x-search',
    description: 'Search X',
    credentials: [
      { key: 'XAI_API_KEY', label: 'xAI API Key', required: true },
    ],
  };
  const parsed = SkillManifestSchema.parse(raw);
  expect(parsed.credentials).toHaveLength(1);
  expect(parsed.credentials![0]!.key).toBe('XAI_API_KEY');
  expect(parsed.credentials![0]!.required).toBe(true);
});

it('accepts manifest without credentials (optional)', () => {
  const raw = { name: 'weather', description: 'Weather skill' };
  const parsed = SkillManifestSchema.parse(raw);
  expect(parsed.credentials).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @agentoctopus/registry exec vitest run tests/manifest-schema.test.ts
```

Expected: FAIL — `credentials` is not a known field yet.

- [ ] **Step 3: Add `credentials` to `SkillManifestSchema`**

In `packages/registry/src/manifest-schema.ts`, add after `llm_powered`:

```ts
credentials: z.array(z.object({
  key: z.string(),
  label: z.string(),
  required: z.boolean().default(true),
})).optional(),
```

Also add the exported type at the bottom of the file:

```ts
export type SkillCredential = { key: string; label: string; required: boolean };
```

And export it from `packages/registry/src/index.ts`:

```ts
export type { SkillCredential } from './manifest-schema.js';
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @agentoctopus/registry exec vitest run tests/manifest-schema.test.ts
```

Expected: PASS — all 4 tests green.

- [ ] **Step 5: Build the registry package**

```bash
pnpm --filter @agentoctopus/registry build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add packages/registry/src/manifest-schema.ts packages/registry/src/index.ts packages/registry/tests/manifest-schema.test.ts
git commit -m "feat(registry): add credentials field to SkillManifestSchema"
```

---

## Task 2: Add `credentials` to x-search SKILL.md

**Files:**
- Modify: `registry/skills/x-search/SKILL.md`

- [ ] **Step 1: Update `registry/skills/x-search/SKILL.md`**

Replace the file content with:

```markdown
---
name: x-search
description: >
  Search X (Twitter) posts using the xAI Grok API with real-time access to X content.
tags: [x, twitter, social, search]
version: 1.0.0
adapter: subprocess
hosting: local
input_schema:
  query: string
output_schema:
  report: string
auth: api_key
rating: 3.0
invocations: 0
credentials:
  - key: XAI_API_KEY
    label: "xAI API Key (get one at console.x.ai)"
    required: true
---

## Instructions

Search X (Twitter) for posts matching the user's query using the xAI Grok API.
Parse the query, call the Grok live-search endpoint, and return a concise
plain-text summary of the top results including author handles and timestamps.
```

- [ ] **Step 2: Smoke-test the registry still loads**

```bash
OCTOPUS_INPUT='{"query":"test"}' node registry/skills/x-search/scripts/invoke.js 2>&1 | head -5
```

Expected: JSON output or an API key error — no parse crash.

- [ ] **Step 3: Commit**

```bash
git add registry/skills/x-search/SKILL.md
git commit -m "feat(registry): add credentials declaration to x-search skill"
```

---

## Task 3: Create `apps/cli/src/config.ts`

**Files:**
- Create: `apps/cli/src/config.ts`

- [ ] **Step 1: Create `apps/cli/src/config.ts`**

```ts
import fs from 'fs';
import path from 'path';
import os from 'os';

export interface OctopusConfig {
  skillsDir: string;
  ratingsPath: string;
  credentials: Record<string, string>;
}

const DEFAULT_HOME = path.join(os.homedir(), '.agentoctopus');
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_HOME, 'octopus.json');

export function getDefaultHome(): string {
  return DEFAULT_HOME;
}

export function getConfigPath(): string {
  return DEFAULT_CONFIG_PATH;
}

export function loadOctopusConfig(): OctopusConfig | null {
  if (!fs.existsSync(DEFAULT_CONFIG_PATH)) return null;
  try {
    const raw = fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8');
    return JSON.parse(raw) as OctopusConfig;
  } catch {
    return null;
  }
}

export function saveOctopusConfig(config: OctopusConfig): void {
  fs.mkdirSync(DEFAULT_HOME, { recursive: true });
  fs.writeFileSync(DEFAULT_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

export function defaultConfig(skillsDir?: string): OctopusConfig {
  const home = DEFAULT_HOME;
  return {
    skillsDir: skillsDir ?? path.join(home, 'skills'),
    ratingsPath: path.join(home, 'ratings.json'),
    credentials: {},
  };
}
```

- [ ] **Step 2: Build CLI to verify no TypeScript errors**

```bash
pnpm --filter @agentoctopus/cli build
```

Expected: compiles cleanly.

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/config.ts
git commit -m "feat(cli): add config.ts — loadOctopusConfig/saveOctopusConfig for octopus.json"
```

---

## Task 4: Wire `config.ts` into `bootstrap()` in `index.ts`

**Files:**
- Modify: `apps/cli/src/index.ts`

- [ ] **Step 1: Update `bootstrap()` to use `loadOctopusConfig()`**

In `apps/cli/src/index.ts`, add the import at the top (after existing imports):

```ts
import { loadOctopusConfig } from './config.js';
```

Replace the existing `bootstrap()` function body's first three lines:

```ts
// OLD:
const rootDir = process.env.OCTOPUS_ROOT || process.cwd();
const skillsDir = process.env.REGISTRY_PATH || path.join(rootDir, 'registry', 'skills');
const ratingsPath = process.env.RATINGS_PATH || path.join(rootDir, 'registry', 'ratings.json');
```

With:

```ts
// NEW:
const octopusConfig = loadOctopusConfig();
const skillsDir =
  process.env.REGISTRY_PATH ||
  octopusConfig?.skillsDir ||
  path.join(process.env.OCTOPUS_ROOT || process.cwd(), 'registry', 'skills');
const ratingsPath =
  process.env.RATINGS_PATH ||
  octopusConfig?.ratingsPath ||
  path.join(process.env.OCTOPUS_ROOT || process.cwd(), 'registry', 'ratings.json');

// Merge stored credentials into process.env so scripts/invoke.js can read them
if (octopusConfig?.credentials) {
  for (const [key, value] of Object.entries(octopusConfig.credentials)) {
    if (!process.env[key]) process.env[key] = value;
  }
}
```

- [ ] **Step 2: Build and verify**

```bash
pnpm --filter @agentoctopus/cli build
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/index.ts
git commit -m "feat(cli): bootstrap() reads skillsDir and credentials from octopus.json"
```

---

## Task 5: Copy bundled skills into `apps/cli/skills/`

**Files:**
- Create: `apps/cli/skills/` (directory with skill copies)
- Modify: `apps/cli/package.json`

- [ ] **Step 1: Copy skill directories**

```bash
cp -r registry/skills/weather apps/cli/skills/weather
cp -r registry/skills/translation apps/cli/skills/translation
cp -r registry/skills/ip-lookup apps/cli/skills/ip-lookup
cp -r registry/skills/x-search apps/cli/skills/x-search
```

Verify:

```bash
ls apps/cli/skills/
```

Expected: `weather  translation  ip-lookup  x-search`

- [ ] **Step 2: Add `skills` to `files` in `apps/cli/package.json`**

Change:

```json
"files": [
  "README.md",
  "dist"
],
```

To:

```json
"files": [
  "README.md",
  "dist",
  "skills"
],
```

- [ ] **Step 3: Commit**

```bash
git add apps/cli/skills/ apps/cli/package.json
git commit -m "feat(cli): bundle built-in skills in npm package under apps/cli/skills/"
```

---

## Task 6: Update onboarding — Step 0 (skills directory) + bundled copy

**Files:**
- Modify: `apps/cli/src/onboard.ts`

- [ ] **Step 1: Add imports and helper to `onboard.ts`**

At the top of `apps/cli/src/onboard.ts`, add:

```ts
import os from 'os';
import { fileURLToPath } from 'url';
import { loadOctopusConfig, saveOctopusConfig, defaultConfig, getDefaultHome } from './config.js';
```

Add a helper function after the existing `discoverSkills` function:

```ts
function getBundledSkillsDir(): string {
  const __dir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(__dir, '..', 'skills');
}

async function copyBundledSkills(targetSkillsDir: string): Promise<{ copied: string[]; skipped: string[] }> {
  const bundledDir = getBundledSkillsDir();
  const copied: string[] = [];
  const skipped: string[] = [];

  if (!fs.existsSync(bundledDir)) {
    return { copied, skipped };
  }

  for (const entry of fs.readdirSync(bundledDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = path.join(bundledDir, entry.name);
    const dst = path.join(targetSkillsDir, entry.name);

    if (fs.existsSync(dst)) {
      skipped.push(entry.name);
      continue;
    }

    fs.mkdirSync(dst, { recursive: true });
    copyDir(src, dst);
    copied.push(entry.name);
  }

  return { copied, skipped };
}

function copyDir(src: string, dst: string): void {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dstPath, { recursive: true });
      copyDir(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}
```

- [ ] **Step 2: Insert Step 0 into `runOnboarding()`**

In `runOnboarding()`, change `const totalSteps = 5;` to `const totalSteps = 6;`.

Insert the following block immediately after the `printBanner()` call and before the existing `.env` overwrite check:

```ts
// ── Step 0: Skills Directory ────────────────────────────────────────────
printStep(0, totalSteps, 'Skills Directory');

const defaultSkillsDir = path.join(getDefaultHome(), 'skills');

const skillsDir = await input({
  message: 'Where should AgentOctopus store your skills?',
  default: defaultSkillsDir,
});

const resolvedSkillsDir = path.resolve(skillsDir);
fs.mkdirSync(resolvedSkillsDir, { recursive: true });

console.log(chalk.gray('\n  Copying bundled skills...'));
const { copied, skipped } = await copyBundledSkills(resolvedSkillsDir);

if (copied.length > 0) {
  console.log(chalk.green(`  Installed: ${copied.join(', ')}`));
}
if (skipped.length > 0) {
  console.log(chalk.gray(`  Already exists (skipped): ${skipped.join(', ')}`));
}
console.log('');

// Save config early so bootstrap() can find skills
const octopusHome = path.dirname(resolvedSkillsDir) === getDefaultHome()
  ? getDefaultHome()
  : path.dirname(resolvedSkillsDir);
const ratingsPath = path.join(octopusHome, 'ratings.json');
saveOctopusConfig({ skillsDir: resolvedSkillsDir, ratingsPath, credentials: {} });
```

- [ ] **Step 3: Update existing step numbers in `printStep()` calls**

The existing steps 1–5 need their step numbers incremented to 1–6 (and totalSteps is already updated). Change each:

- `printStep(1, totalSteps, 'LLM Provider')` → `printStep(1, totalSteps, 'LLM Provider')` *(no change needed — already 1)*
- But verify the call chain still reads `1, 2, 3, 4, 5` in the file and confirm `totalSteps` is the only change needed. The existing numbers are 1–5, and with totalSteps=6 they become steps 1–5 of 6, which is fine. No individual step number changes needed.

- [ ] **Step 4: Build and quick smoke test**

```bash
pnpm --filter @agentoctopus/cli build
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/onboard.ts
git commit -m "feat(cli): onboarding Step 0 — choose skills dir and copy bundled skills"
```

---

## Task 7: Credential prompting in skill selection (onboarding Step 5)

**Files:**
- Modify: `apps/cli/src/onboard.ts`

- [ ] **Step 1: Update `discoverSkills()` to include credential info**

Replace the existing `discoverSkills` function signature and return type:

```ts
// OLD return type:
function discoverSkills(rootDir: string): Array<{ name: string; description: string }>

// NEW:
interface DiscoveredSkill {
  name: string;
  description: string;
  credentials: Array<{ key: string; label: string; required: boolean }>;
}

function discoverSkills(skillsDir: string): DiscoveredSkill[] {
  if (!fs.existsSync(skillsDir)) return [];

  const skills: DiscoveredSkill[] = [];

  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;

    const content = fs.readFileSync(skillMdPath, 'utf8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    let description = entry.name;
    let credentials: Array<{ key: string; label: string; required: boolean }> = [];

    if (fmMatch) {
      const lines = fmMatch[1]!.split('\n');
      const descLine = lines.find((l) => l.startsWith('description:'));
      if (descLine) {
        description = descLine.slice('description:'.length).trim();
      }
      // Parse credentials block (YAML list)
      const credStart = lines.findIndex((l) => l.trim() === 'credentials:');
      if (credStart !== -1) {
        for (let i = credStart + 1; i < lines.length; i++) {
          const line = lines[i]!;
          if (!line.startsWith('  -') && !line.startsWith('    ')) break;
          const keyMatch = line.match(/key:\s*["']?([^"'\n]+)["']?/);
          const labelMatch = line.match(/label:\s*["']?([^"'\n]+)["']?/);
          const requiredMatch = line.match(/required:\s*(true|false)/);
          if (keyMatch && labelMatch) {
            credentials.push({
              key: keyMatch[1]!.trim(),
              label: labelMatch[1]!.trim(),
              required: requiredMatch ? requiredMatch[1] === 'true' : true,
            });
          }
        }
      }
    }

    skills.push({ name: entry.name, description, credentials });
  }

  return skills;
}
```

- [ ] **Step 2: Update the skill selection step to pass `resolvedSkillsDir` and prompt for credentials**

Find the existing Step 4 (skill selection) block in `runOnboarding()` and replace it entirely with:

```ts
// ── Step 5: Skill Selection ────────────────────────────────────────────
printStep(5, totalSteps, 'Skill Selection');

const availableSkills = discoverSkills(resolvedSkillsDir);

if (availableSkills.length === 0) {
  console.log(chalk.gray('  No skills found. Skipping skill selection.'));
  console.log(chalk.gray('  Install skills later with: ') + chalk.yellow('octopus skill add <skill>'));
} else {
  const enabledSkills = await checkbox({
    message: 'Select skills to enable:',
    choices: availableSkills.map((s) => ({
      value: s.name,
      name: `${s.name}${s.credentials.length > 0 ? ' 🔑' : ''} — ${chalk.gray(s.description)}`,
      checked: true,
    })),
  });

  config.disabledSkills = availableSkills
    .map((s) => s.name)
    .filter((name) => !enabledSkills.includes(name));

  // Prompt for credentials of enabled skills that need them
  const collectedCredentials: Record<string, string> = {};
  for (const skill of availableSkills) {
    if (config.disabledSkills.includes(skill.name)) continue;
    for (const cred of skill.credentials) {
      if (collectedCredentials[cred.key]) continue; // already collected
      console.log('');
      console.log(chalk.cyan(`  Skill "${skill.name}" requires an API key:`));
      const value = await password({
        message: `  ${cred.label}:`,
        mask: '*',
        validate: cred.required ? (v) => (v.length > 0 ? true : 'This key is required') : undefined,
      });
      if (value) collectedCredentials[cred.key] = value;
    }
  }

  // Persist collected credentials into octopus.json
  if (Object.keys(collectedCredentials).length > 0) {
    const existing = loadOctopusConfig() ?? { skillsDir: resolvedSkillsDir, ratingsPath, credentials: {} };
    existing.credentials = { ...existing.credentials, ...collectedCredentials };
    saveOctopusConfig(existing);
  }
}
```

Note: the variable `ratingsPath` is already defined from Step 0 in Task 6. Remove the old `discoverSkills(root)` call.

- [ ] **Step 3: Build**

```bash
pnpm --filter @agentoctopus/cli build
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/onboard.ts
git commit -m "feat(cli): credential prompting in onboarding skill selection step"
```

---

## Task 8: Create `apps/cli/src/skill-create.ts`

**Files:**
- Create: `apps/cli/src/skill-create.ts`

- [ ] **Step 1: Create the file**

```ts
import { input, select, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { SkillManifestSchema } from '@agentoctopus/registry';
import type { LLMConfig } from '@agentoctopus/core';
import { LLMClient } from '@agentoctopus/core';
import { loadOctopusConfig, defaultConfig } from './config.js';

// ── Template scaffold ─────────────────────────────────────────────────────────

const SKILL_MD_TEMPLATE = `---
name: my-skill
description: Describe what this skill does.
tags: [example]
version: 1.0.0
adapter: subprocess
hosting: local
auth: none
input_schema:
  query: string
output_schema:
  result: string
---

## Instructions

Describe how the skill should behave. The router uses this text to decide
when to invoke the skill.
`;

const INVOKE_JS_TEMPLATE = `#!/usr/bin/env node
// TODO: implement your skill logic here
const input = JSON.parse(process.env.OCTOPUS_INPUT || '{}');
const { query } = input;

// Example: fetch from an external API
// const res = await fetch(\`https://api.example.com?q=\${query}\`);
// const data = await res.json();

console.log(JSON.stringify({ result: 'TODO' }));
`;

// ── LLM prompt ────────────────────────────────────────────────────────────────

function buildLLMPrompt(answers: {
  description: string;
  type: 'api' | 'llm';
  endpoint?: string;
  authType?: string;
  sampleIO?: string;
  constraints?: string;
}): string {
  const apiSection = answers.type === 'api'
    ? `The skill calls an external API.
Endpoint: ${answers.endpoint || 'not specified'}
Auth: ${answers.authType || 'none'}
Sample input/output: ${answers.sampleIO || 'not provided'}`
    : `The skill is LLM-only (no external API calls).
Constraints/tone: ${answers.constraints || 'none specified'}`;

  return `You are generating a SKILL.md file for AgentOctopus.

A SKILL.md file has YAML frontmatter followed by a markdown instructions block.

User description: ${answers.description}
${apiSection}

Generate a valid SKILL.md with this exact structure:
---
name: <slug, lowercase, hyphens>
description: <one sentence, what it does and when to use it>
tags: [<3-5 relevant tags>]
version: 1.0.0
adapter: ${answers.type === 'api' ? 'subprocess' : 'http'}
hosting: local
auth: ${answers.authType === 'none' || answers.type === 'llm' ? 'none' : answers.authType || 'none'}
llm_powered: ${answers.type === 'llm' ? 'true' : 'false'}
input_schema:
  query: string
output_schema:
  result: string
---

## Instructions

<2-4 sentences describing the behavior, how to extract input, and what to return>

Return ONLY the SKILL.md content, no explanation.`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveSkillsDir(): string {
  if (process.env.REGISTRY_PATH) return process.env.REGISTRY_PATH;
  const config = loadOctopusConfig();
  if (config?.skillsDir) return config.skillsDir;
  return path.join(process.cwd(), 'registry', 'skills');
}

function writeSkillFiles(skillDir: string, skillMd: string, writeScript: boolean): void {
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMd, 'utf8');

  if (writeScript) {
    const scriptsDir = path.join(skillDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const invokeJs = path.join(scriptsDir, 'invoke.js');
    if (!fs.existsSync(invokeJs)) {
      fs.writeFileSync(invokeJs, INVOKE_JS_TEMPLATE, 'utf8');
    }
  }
}

// ── Template mode ─────────────────────────────────────────────────────────────

export async function runSkillTemplate(skillsDir?: string): Promise<void> {
  const targetDir = skillsDir ?? resolveSkillsDir();
  const skillName = 'my-skill';
  const skillDir = path.join(targetDir, skillName);

  if (fs.existsSync(skillDir)) {
    console.log(chalk.red(`\n  Directory already exists: ${skillDir}`));
    console.log(chalk.gray('  Choose a different name or remove the existing skill.\n'));
    return;
  }

  writeSkillFiles(skillDir, SKILL_MD_TEMPLATE, true);

  console.log(chalk.green(`\n  Scaffolded skill at ${skillDir}`));
  console.log(chalk.gray('  Edit SKILL.md to define your skill, then restart the server.\n'));
}

// ── AI wizard mode ────────────────────────────────────────────────────────────

export async function runSkillCreateWizard(skillsDir?: string): Promise<void> {
  const targetDir = skillsDir ?? resolveSkillsDir();

  console.log(chalk.bold('\n  Skill Create Wizard\n'));

  // Step 1: description
  const description = await input({
    message: 'What does your skill do?',
    validate: (v) => (v.trim().length > 0 ? true : 'Description is required'),
  });

  // Step 2: type
  const skillType = await select<'api' | 'llm'>({
    message: 'How does it work?',
    choices: [
      { value: 'api', name: 'Calls an external API' },
      { value: 'llm', name: 'LLM-only (no external calls)' },
    ],
  });

  const answers: Parameters<typeof buildLLMPrompt>[0] = { description, type: skillType };

  if (skillType === 'api') {
    answers.endpoint = await input({ message: 'API endpoint URL (optional, press Enter to skip):' });
    answers.authType = await select({
      message: 'Authentication type:',
      choices: [
        { value: 'none', name: 'None' },
        { value: 'api_key', name: 'API key' },
        { value: 'bearer', name: 'Bearer token' },
        { value: 'oauth', name: 'OAuth' },
      ],
    });
    answers.sampleIO = await input({ message: 'Describe a sample input and expected output (optional):' });
  } else {
    answers.constraints = await input({ message: 'Any constraints, tone, or output format? (optional):' });
  }

  // Step 4: AI generation
  const llmProvider = (process.env.LLM_PROVIDER as 'openai' | 'gemini' | 'ollama') || 'openai';
  const llmConfig: LLMConfig = {
    provider: llmProvider,
    model: process.env.LLM_MODEL || 'gpt-4o-mini',
    apiKey: process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY,
    baseUrl: llmProvider === 'openai' ? process.env.OPENAI_BASE_URL : process.env.OLLAMA_BASE_URL,
  };

  const llm = new LLMClient(llmConfig);
  console.log(chalk.gray('\n  Generating SKILL.md with AI...\n'));

  let skillMd: string;
  let additionalNotes = '';

  // Regeneration loop
  while (true) {
    const prompt = buildLLMPrompt(answers) + (additionalNotes ? `\n\nAdditional notes: ${additionalNotes}` : '');
    try {
      skillMd = await llm.complete(prompt);
    } catch (err) {
      console.error(chalk.red(`  AI generation failed: ${(err as Error).message}`));
      console.log(chalk.gray('  Falling back to template scaffold.\n'));
      await runSkillTemplate(targetDir);
      return;
    }

    // Validate against schema
    try {
      const { data } = matter(skillMd);
      SkillManifestSchema.parse(data);
    } catch {
      console.log(chalk.yellow('  Warning: generated manifest has validation issues. You can edit it manually.\n'));
    }

    console.log(chalk.cyan('─── Generated SKILL.md ───────────────────────────────────────'));
    console.log(skillMd);
    console.log(chalk.cyan('──────────────────────────────────────────────────────────────\n'));

    const action = await select({
      message: 'Does this look right?',
      choices: [
        { value: 'yes', name: 'Yes — write the files' },
        { value: 'regenerate', name: 'Regenerate — add notes for the AI' },
        { value: 'template', name: 'Use template instead (skip AI)' },
      ],
    });

    if (action === 'yes') break;
    if (action === 'template') {
      await runSkillTemplate(targetDir);
      return;
    }
    // regenerate
    additionalNotes = await input({ message: 'Notes for the AI (what to change):' });
  }

  // Extract skill name from generated frontmatter for directory naming
  let skillName = 'my-skill';
  try {
    const { data } = matter(skillMd);
    if (typeof data.name === 'string') skillName = data.name;
  } catch { /* use default */ }

  const skillDir = path.join(targetDir, skillName);

  if (fs.existsSync(skillDir)) {
    const overwrite = await confirm({
      message: `Skill directory "${skillDir}" already exists. Overwrite?`,
      default: false,
    });
    if (!overwrite) {
      console.log(chalk.gray('\n  Cancelled. No files written.\n'));
      return;
    }
  }

  writeSkillFiles(skillDir, skillMd, skillType === 'api');

  console.log(chalk.green(`\n  Skill written to ${skillDir}`));
  if (skillType === 'api') {
    console.log(chalk.gray(`  Edit scripts/invoke.js to implement the API call.`));
  }
  console.log(chalk.yellow('  Restart the server to pick up the new skill.\n'));
}
```

- [ ] **Step 2: Verify `LLMClient` is exported from `@agentoctopus/core`**

```bash
grep -n "LLMClient" packages/core/src/index.ts
```

If not exported, add it: open `packages/core/src/index.ts` and add:

```ts
export { LLMClient } from './llm-client.js';
```

- [ ] **Step 3: Build**

```bash
pnpm --filter @agentoctopus/cli build
```

Expected: compiles cleanly. If `LLMClient` import fails, check `packages/core/src/llm-client.ts` for the actual export name and adjust the import in `skill-create.ts`.

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/skill-create.ts packages/core/src/index.ts
git commit -m "feat(cli): add skill-create.ts — AI wizard and --template scaffold"
```

---

## Task 9: Add `skill` subcommand group to `index.ts`

**Files:**
- Modify: `apps/cli/src/index.ts`

- [ ] **Step 1: Add import for skill-create**

At the top of `apps/cli/src/index.ts`, add:

```ts
import { runSkillCreateWizard, runSkillTemplate } from './skill-create.js';
```

- [ ] **Step 2: Add the `skill` subcommand group**

Add this block before `program.parse()` at the bottom of `apps/cli/src/index.ts`:

```ts
// ── octopus skill <subcommand> ─────────────────────────────────────────────
const skillCmd = program
  .command('skill')
  .description('Manage skills — create, install, remove, search, publish, list');

skillCmd
  .command('create')
  .description('Create a new skill with AI assistance (or use --template for a blank scaffold)')
  .option('--template', 'Skip AI and write a blank scaffold instead')
  .action(async (options: { template?: boolean }) => {
    if (options.template) {
      await runSkillTemplate();
    } else {
      const onboarded = await ensureOnboarded();
      if (!onboarded) return;
      await runSkillCreateWizard();
    }
  });

skillCmd
  .command('list')
  .description('List all available skills')
  .action(async () => {
    await program.parseAsync(['', '', 'list'], { from: 'user' });
  });

skillCmd
  .command('add <slug>')
  .description('Install a skill from ClaWHub (clawhub.ai)')
  .option('--version <version>', 'Install a specific version')
  .option('--force', 'Overwrite existing skill')
  .option('--registry <url>', 'Custom ClaWHub registry URL')
  .action(async (slug: string, options: { version?: string; force?: boolean; registry?: string }) => {
    // Delegate to top-level add
    const args = ['', '', 'add', slug];
    if (options.version) args.push('--version', options.version);
    if (options.force) args.push('--force');
    if (options.registry) args.push('--registry', options.registry);
    await program.parseAsync(args, { from: 'user' });
  });

skillCmd
  .command('remove <name>')
  .description('Remove an installed skill')
  .action(async (name: string) => {
    await program.parseAsync(['', '', 'remove', name], { from: 'user' });
  });

skillCmd
  .command('search <query>')
  .description('Search for skills on ClaWHub')
  .option('--registry <url>', 'Custom ClaWHub registry URL')
  .action(async (query: string, options: { registry?: string }) => {
    const args = ['', '', 'search', query];
    if (options.registry) args.push('--registry', options.registry);
    await program.parseAsync(args, { from: 'user' });
  });

skillCmd
  .command('publish [dir]')
  .description('Publish a skill to the marketplace')
  .option('--server <url>', 'Marketplace server URL', 'http://localhost:3000')
  .option('--author <name>', 'Author name')
  .action(async (dir: string | undefined, options: { server: string; author?: string }) => {
    const args = ['', '', 'publish'];
    if (dir) args.push(dir);
    args.push('--server', options.server);
    if (options.author) args.push('--author', options.author);
    await program.parseAsync(args, { from: 'user' });
  });
```

- [ ] **Step 3: Build**

```bash
pnpm --filter @agentoctopus/cli build
```

Expected: no errors.

- [ ] **Step 4: Smoke-test the subcommand group**

```bash
node apps/cli/dist/index.js skill --help
```

Expected output includes: `create`, `list`, `add`, `remove`, `search`, `publish`.

```bash
node apps/cli/dist/index.js skill create --help
```

Expected output includes `--template` option.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/index.ts
git commit -m "feat(cli): add 'octopus skill' subcommand group with create, list, add, remove, search, publish"
```

---

## Task 10: Run full test suite and fix any failures

- [ ] **Step 1: Run all tests**

```bash
pnpm test
```

Expected: all tests pass (35+). Note any failures.

- [ ] **Step 2: If registry tests fail due to new `credentials` field**

The existing `registry.test.ts` mocks use manifest fixtures without `credentials`. These should still pass since `credentials` is `optional()`. If any test fails with a Zod parse error, the mock manifest likely has an unrecognized field — check and ensure `SkillManifestSchema` uses `.passthrough()` or that mocks don't include extra fields.

- [ ] **Step 3: Fix any failures, re-run**

```bash
pnpm test
```

Expected: all green.

- [ ] **Step 4: Commit any fixes**

```bash
git add -p   # stage only test/fix files
git commit -m "fix(cli): fix test failures after bundled skills and credential changes"
```

---

## Task 11: Documentation updates

**Files:**
- Modify: `README.md`
- Modify: `TEST_INSTRUCTIONS.md`
- Modify: `implementation_plan.md`

- [ ] **Step 1: Update `README.md`**

Add a new section "Bundled Skills & User Home" explaining:
- Skills are installed to `~/.agentoctopus/skills/` on first `octopus onboard`
- `~/.agentoctopus/octopus.json` stores the skills dir path and any API key credentials
- To change the skills directory, re-run `octopus onboard`

Add a new section "Creating Skills" explaining:
- `octopus skill create` — AI-assisted wizard
- `octopus skill create --template` — blank scaffold
- `octopus skill add <slug>` — install from ClaWHub

- [ ] **Step 2: Update `TEST_INSTRUCTIONS.md`**

Add checklist rows:

```
| octopus onboard — Step 0 copies bundled skills to chosen dir | Run onboard, confirm weather/translation/ip-lookup appear in target dir |
| octopus onboard — credential prompt for x-search | Enable x-search in skill selection, confirm XAI_API_KEY is saved to octopus.json |
| octopus skill create --template | Confirm SKILL.md and scripts/invoke.js scaffold written to skillsDir/my-skill/ |
| octopus skill create (AI) | Confirm wizard prompts, AI generates SKILL.md, files written on "Yes" |
| octopus skill list | Same output as octopus list |
| bootstrap() reads from octopus.json | After onboard, octopus ask "weather in Tokyo" uses ~/.agentoctopus/skills |
```

- [ ] **Step 3: Update `implementation_plan.md`**

Mark any relevant phase as complete or add a new phase entry for this work.

- [ ] **Step 4: Commit**

```bash
git add README.md TEST_INSTRUCTIONS.md implementation_plan.md
git commit -m "docs: update README and TEST_INSTRUCTIONS for bundled skills and octopus skill create"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| `apps/cli/skills/` bundled skill directory | Task 5 |
| `"files"` update in `package.json` | Task 5 |
| `apps/cli/src/config.ts` with `loadOctopusConfig`/`saveOctopusConfig` | Task 3 |
| `bootstrap()` resolution order (env → octopus.json → cwd fallback) | Task 4 |
| Credentials merged into `process.env` at runtime | Task 4 |
| Onboarding Step 0: choose skills dir, copy bundled skills | Task 6 |
| Credential prompting in skill selection | Task 7 |
| `credentials` field in `SkillManifestSchema` | Task 1 |
| x-search SKILL.md gets `credentials` | Task 2 |
| `octopus skill create` AI wizard | Task 8 |
| `octopus skill create --template` scaffold | Task 8 |
| `skill` subcommand group with backwards-compat aliases | Task 9 |
| Docs updated | Task 11 |

All spec requirements covered. No gaps found.
