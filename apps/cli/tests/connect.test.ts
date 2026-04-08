import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractOpenClawConfig, type OpenClawExtracted } from '../src/connect.js';

describe('extractOpenClawConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octopus-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  function writeOpenClawFiles(authProfiles: object, models: object) {
    const agentDir = path.join(tmpDir, 'agents', 'main', 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'auth-profiles.json'), JSON.stringify(authProfiles));
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify(models));
  }

  it('extracts openrouter provider as openai-compatible', () => {
    writeOpenClawFiles(
      { version: 1, profiles: { 'openrouter:default': { type: 'api_key', provider: 'openrouter', key: 'sk-or-test-123' } } },
      { providers: { openrouter: { baseUrl: 'https://openrouter.ai/api/v1' } } }
    );

    const result = extractOpenClawConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('openai');
    expect(result!.apiKey).toBe('sk-or-test-123');
    expect(result!.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('returns null when auth-profiles.json is missing', () => {
    const agentDir = path.join(tmpDir, 'agents', 'main', 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: {} }));

    const result = extractOpenClawConfig(tmpDir);
    expect(result).toBeNull();
  });

  it('returns null when no profiles exist', () => {
    writeOpenClawFiles(
      { version: 1, profiles: {} },
      { providers: {} }
    );

    const result = extractOpenClawConfig(tmpDir);
    expect(result).toBeNull();
  });

  it('extracts model name from primary model setting in openclaw.json', () => {
    writeOpenClawFiles(
      { version: 1, profiles: { 'openrouter:default': { type: 'api_key', provider: 'openrouter', key: 'sk-or-test-456' } } },
      { providers: { openrouter: { baseUrl: 'https://openrouter.ai/api/v1' } } }
    );
    fs.writeFileSync(
      path.join(tmpDir, 'openclaw.json'),
      JSON.stringify({ agents: { defaults: { model: { primary: 'qwen/qwen3-plus:free' } } } })
    );

    const result = extractOpenClawConfig(tmpDir);
    expect(result!.model).toBe('qwen/qwen3-plus:free');
  });

  it('falls back to default model when openclaw.json has no primary model', () => {
    writeOpenClawFiles(
      { version: 1, profiles: { 'openrouter:default': { type: 'api_key', provider: 'openrouter', key: 'sk-or-test-789' } } },
      { providers: { openrouter: { baseUrl: 'https://openrouter.ai/api/v1' } } }
    );

    const result = extractOpenClawConfig(tmpDir);
    expect(result!.model).toBe('openrouter/auto');
  });

  it('uses provider-aware default baseUrl when models.json is absent', () => {
    const agentDir = path.join(tmpDir, 'agents', 'main', 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'auth-profiles.json'),
      JSON.stringify({ version: 1, profiles: { 'openrouter:default': { type: 'api_key', provider: 'openrouter', key: 'sk-or-test-999' } } })
    );
    // No models.json written

    const result = extractOpenClawConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('sets rawProvider to the original provider name', () => {
    writeOpenClawFiles(
      { version: 1, profiles: { 'openrouter:default': { type: 'api', provider: 'openrouter', key: 'sk-test-key' } }, lastGood: { openrouter: 'openrouter:default' } },
      { providers: { openrouter: { baseUrl: 'https://openrouter.ai/api/v1' } } }
    );

    const result = extractOpenClawConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.rawProvider).toBe('openrouter');
    expect(result!.provider).toBe('openai'); // mapped
  });
});
