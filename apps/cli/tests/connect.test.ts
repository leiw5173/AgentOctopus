import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { extractOpenClawConfig, extractAllOpenClawConfigs, checkServiceReachable, type OpenClawExtracted } from '../src/connect.js';

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

  it('extracts active model and matches its provider from openclaw.json defaults', () => {
    writeOpenClawFiles(
      { version: 1, profiles: {
        'openai:default': { type: 'api_key', provider: 'openai', key: 'sk-openai-key' },
        'opencode-go:default': { type: 'api_key', provider: 'opencode-go', key: 'sk-opencode-key' }
      } },
      { providers: {} }
    );
    fs.writeFileSync(
      path.join(tmpDir, 'openclaw.json'),
      JSON.stringify({ agents: { defaults: { model: { primary: 'opencode-go/kimi-k2.6' } } } })
    );

    const result = extractOpenClawConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('openai'); // mapped
    expect(result!.rawProvider).toBe('opencode-go');
    expect(result!.apiKey).toBe('sk-opencode-key');
    expect(result!.baseUrl).toBe('https://opencode.ai/zen/go/v1');
    expect(result!.model).toBe('kimi-k2.6');
  });

  it('extracts active model and matches its provider from openclaw.json main agent', () => {
    writeOpenClawFiles(
      { version: 1, profiles: {
        'openai:default': { type: 'api_key', provider: 'openai', key: 'sk-openai-key' },
        'opencode-go:default': { type: 'api_key', provider: 'opencode-go', key: 'sk-opencode-key' }
      } },
      { providers: {} }
    );
    fs.writeFileSync(
      path.join(tmpDir, 'openclaw.json'),
      JSON.stringify({
        agents: {
          defaults: { model: { primary: 'openai/gpt-4o' } },
          list: [{ id: 'main', model: { primary: 'opencode-go/deepseek-v4-flash' } }]
        }
      })
    );

    const result = extractOpenClawConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.rawProvider).toBe('opencode-go');
    expect(result!.apiKey).toBe('sk-opencode-key');
    expect(result!.model).toBe('deepseek-v4-flash');
  });

  it('falls back to auth-state.json lastGood active profile when activeModel is not set', () => {
    writeOpenClawFiles(
      { version: 1, profiles: {
        'openai:default': { type: 'api_key', provider: 'openai', key: 'sk-openai-key' },
        'opencode-go:default': { type: 'api_key', provider: 'opencode-go', key: 'sk-opencode-key' }
      } },
      { providers: {} }
    );
    const agentDir = path.join(tmpDir, 'agents', 'main', 'agent');
    fs.writeFileSync(
      path.join(agentDir, 'auth-state.json'),
      JSON.stringify({ lastGood: { 'opencode-go': 'opencode-go:default' } })
    );

    const result = extractOpenClawConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.rawProvider).toBe('opencode-go');
    expect(result!.apiKey).toBe('sk-opencode-key');
  });
});

describe('extractAllOpenClawConfigs', () => {
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

  it('returns empty array when no auth-profiles.json', () => {
    const agentDir = path.join(tmpDir, 'agents', 'main', 'agent');
    fs.mkdirSync(agentDir, { recursive: true });

    const results = extractAllOpenClawConfigs(tmpDir);
    expect(results).toEqual([]);
  });

  it('returns empty array when no profiles with keys exist', () => {
    writeOpenClawFiles(
      { version: 1, profiles: {} },
      { providers: {} }
    );

    const results = extractAllOpenClawConfigs(tmpDir);
    expect(results).toEqual([]);
  });

  it('returns all profiles ordered by active → lastGood → rest', () => {
    writeOpenClawFiles(
      { version: 1, profiles: {
        'openai:default': { type: 'api_key', provider: 'openai', key: 'sk-openai-key' },
        'opencode-go:default': { type: 'api_key', provider: 'opencode-go', key: 'sk-opencode-key' },
        'gemini:default': { type: 'api_key', provider: 'gemini', key: 'sk-gemini-key' },
      } },
      { providers: {} }
    );
    fs.writeFileSync(
      path.join(tmpDir, 'openclaw.json'),
      JSON.stringify({ agents: { defaults: { model: { primary: 'opencode-go/kimi-k2.6' } } } })
    );
    const agentDir = path.join(tmpDir, 'agents', 'main', 'agent');
    fs.writeFileSync(
      path.join(agentDir, 'auth-state.json'),
      JSON.stringify({ lastGood: { 'gemini': 'gemini:default' } })
    );

    const results = extractAllOpenClawConfigs(tmpDir);
    expect(results.length).toBe(3);
    // Active provider (opencode-go) first — prefix stripped
    expect(results[0].rawProvider).toBe('opencode-go');
    expect(results[0].model).toBe('kimi-k2.6');
    // lastGood provider (gemini) next
    expect(results[1].rawProvider).toBe('gemini');
    // Remaining provider (openai) last
    expect(results[2].rawProvider).toBe('openai');
  });

  it('deduplicates providers so each appears only once', () => {
    writeOpenClawFiles(
      { version: 1, profiles: {
        'openai:1': { type: 'api_key', provider: 'openai', key: 'sk-key-1' },
        'openai:2': { type: 'api_key', provider: 'openai', key: 'sk-key-2' },
      } },
      { providers: {} }
    );

    const results = extractAllOpenClawConfigs(tmpDir);
    expect(results.length).toBe(1);
    expect(results[0].apiKey).toBe('sk-key-1');
  });

  it('skips profiles without a key', () => {
    writeOpenClawFiles(
      { version: 1, profiles: {
        'openai:default': { type: 'api_key', provider: 'openai', key: '' },
        'gemini:default': { type: 'api_key', provider: 'gemini', key: 'sk-gemini-key' },
      } },
      { providers: {} }
    );

    const results = extractAllOpenClawConfigs(tmpDir);
    expect(results.length).toBe(1);
    expect(results[0].rawProvider).toBe('gemini');
  });

  it('uses provider-aware defaults for baseUrl and model', () => {
    writeOpenClawFiles(
      { version: 1, profiles: {
        'ollama:default': { type: 'api_key', provider: 'ollama', key: 'ollama' },
      } },
      { providers: {} }
    );

    const results = extractAllOpenClawConfigs(tmpDir);
    expect(results.length).toBe(1);
    expect(results[0].provider).toBe('ollama');
    expect(results[0].baseUrl).toBe('http://localhost:11434');
    expect(results[0].model).toBe('llama3.2');
  });
});

describe('checkServiceReachable', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>(resolve => server.listen(0, () => resolve()));
    port = (server.address() as any).port;
  });

  afterEach(() => {
    server.close();
  });

  it('returns true when service is reachable', async () => {
    const reachable = await checkServiceReachable(`http://localhost:${port}`);
    expect(reachable).toBe(true);
  });

  it('returns false when service is unreachable', async () => {
    const reachable = await checkServiceReachable('http://localhost:1', 1000);
    expect(reachable).toBe(false);
  });
});
