import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Use vi.hoisted() so paths are initialized before imports (and the os mock) evaluate.
const { TEST_DIR, TEST_HOME } = vi.hoisted(() => {
  const testDir = `/tmp/agentoctopus-test-${Date.now()}`;
  return {
    TEST_DIR: testDir,
    TEST_HOME: `${testDir}/home`,
  };
});

// Override homedir so config-resolver reads from our test directory.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: () => TEST_HOME,
    default: { ...actual, homedir: () => TEST_HOME },
  };
});

import { resetConfig, loadConfig } from '../src/config-resolver.js';

// Snapshot of process.env before tests (to restore between tests)
let envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  resetConfig();
  // Save current process.env state for cleanup
  envSnapshot = { ...process.env };
  if (fs.existsSync(TEST_HOME)) fs.rmSync(TEST_HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_HOME, '.agentoctopus'), { recursive: true });
});

afterEach(() => {
  resetConfig();
  // Restore process.env to snapshot (remove any vars added by dotenv)
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) {
      delete process.env[key];
    } else if (process.env[key] !== envSnapshot[key]) {
      process.env[key] = envSnapshot[key];
    }
  }
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('ConfigResolver', () => {
  it('returns defaults when no config files exist', () => {
    fs.rmSync(path.join(TEST_HOME, '.agentoctopus'), { recursive: true, force: true });
    const config = loadConfig();
    expect(config.llm.provider).toBe('openai');
    expect(config.llm.model).toBe('gpt-4o');
    expect(config.llm.apiKey).toBe('');
    expect(config.gateway.port).toBe(3002);
    expect(config.execution.timeoutMs).toBe(30000);
    expect(config.deploy.mode).toBe('local');
  });

  it('resolves ${VAR} references from .env', () => {
    fs.writeFileSync(
      path.join(TEST_HOME, '.agentoctopus', '.env'),
      'OPENAI_API_KEY=sk-test123\n',
    );
    fs.writeFileSync(
      path.join(TEST_HOME, '.agentoctopus', 'octopus.json'),
      JSON.stringify({
        version: 2,
        llm: { provider: 'openai', model: 'gpt-4o', apiKey: '${OPENAI_API_KEY}' },
      }),
    );

    const config = loadConfig();
    expect(config.llm.apiKey).toBe('sk-test123');
  });

  it('returns empty string for unresolved ${VAR}', () => {
    fs.writeFileSync(
      path.join(TEST_HOME, '.agentoctopus', 'octopus.json'),
      JSON.stringify({
        version: 2,
        llm: { apiKey: '${MISSING_VAR}' },
      }),
    );

    const config = loadConfig();
    expect(config.llm.apiKey).toBe('');
  });

  it('migrates v1 config to v2', () => {
    fs.writeFileSync(
      path.join(TEST_HOME, '.agentoctopus', 'octopus.json'),
      JSON.stringify({
        skillsDir: '/custom/skills',
        ratingsPath: '/custom/ratings.json',
        credentials: {
          LLM_PROVIDER: 'openai',
          LLM_MODEL: 'gpt-4o',
          OPENAI_API_KEY: 'sk-migrated',
          OPENAI_BASE_URL: 'https://custom.api.com/v1',
        },
        gistId: 'abc123',
        maxRetries: 5,
      }),
    );

    const config = loadConfig();
    expect(config.llm.provider).toBe('openai');
    expect(config.llm.model).toBe('gpt-4o');
    expect(config.registry.skillsDir).toBe('/custom/skills');
    expect(config.rating.gistId).toBe('abc123');
    expect(config.execution.maxRetries).toBe(5);

    // Secrets should have been extracted to .env
    const envContent = fs.readFileSync(path.join(TEST_HOME, '.agentoctopus', '.env'), 'utf8');
    expect(envContent).toContain('OPENAI_API_KEY=sk-migrated');

    // Config should have ${VAR} reference after migration write-back
    const configFile = JSON.parse(fs.readFileSync(path.join(TEST_HOME, '.agentoctopus', 'octopus.json'), 'utf8'));
    expect(configFile.llm.apiKey).toBe('${OPENAI_API_KEY}');
  });

  it('caches config on subsequent calls', () => {
    const a = loadConfig();
    const b = loadConfig();
    expect(a).toBe(b);
  });

  it('respects override=false for .env (existing env wins)', () => {
    process.env.TEST_VAR = 'from-process';
    fs.writeFileSync(
      path.join(TEST_HOME, '.agentoctopus', '.env'),
      'TEST_VAR=from-file\n',
    );
    fs.writeFileSync(
      path.join(TEST_HOME, '.agentoctopus', 'octopus.json'),
      JSON.stringify({ version: 2 }),
    );

    loadConfig();
    expect(process.env.TEST_VAR).toBe('from-process');
    delete process.env.TEST_VAR;
  });

  it('filters unknown keys via Zod', () => {
    fs.writeFileSync(
      path.join(TEST_HOME, '.agentoctopus', 'octopus.json'),
      JSON.stringify({
        version: 2,
        llm: { provider: 'openai', model: 'gpt-4o', unknownKey: 'should-be-stripped' },
      }),
    );

    const config = loadConfig();
    expect(config.llm.provider).toBe('openai');
    expect((config.llm as Record<string, unknown>).unknownKey).toBeUndefined();
  });
});
