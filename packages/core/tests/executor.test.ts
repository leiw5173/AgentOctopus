import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Executor, extractCredentialErrors } from '../src/executor.js';
import { SkillRegistry } from '@agentoctopus/registry';
import { HttpAdapter, McpAdapter, SubprocessAdapter } from '@agentoctopus/adapters';

vi.mock('@agentoctopus/adapters', () => {
  return {
    HttpAdapter: vi.fn(),
    McpAdapter: vi.fn(),
    SubprocessAdapter: vi.fn(),
  };
});

describe('Executor', () => {
  let mockRegistry: import('vitest').Mocked<SkillRegistry>;
  
  beforeEach(() => {
    vi.resetAllMocks();
    mockRegistry = {
      recordInvocation: vi.fn(),
      recordInvocationMetrics: vi.fn(),
      readInstructions: vi.fn().mockReturnValue(''),
    } as any;
    
    // Setup instances returned by constructor mocks
    vi.mocked(HttpAdapter).mockImplementation(() => ({
      invoke: vi.fn().mockResolvedValue({ success: true, rawText: '{"result":"http output"}' })
    } as any));
    
    vi.mocked(McpAdapter).mockImplementation(() => ({
      invoke: vi.fn().mockResolvedValue({ success: true, rawText: '{"output":"mcp output"}' })
    } as any));
    
    vi.mocked(SubprocessAdapter).mockImplementation(() => ({
      invoke: vi.fn().mockResolvedValue({ success: true, rawText: 'subprocess output' })
    } as any));
  });

  it('routes to SubprocessAdapter when skill.adapter is subprocess', async () => {
    const executor = new Executor(mockRegistry);
    
    const mockSkill = {
      manifest: { name: 'test-subprocess', adapter: 'subprocess' }
    } as any;
    
    const result = await executor.execute(mockSkill, { query: 'test' });

    expect(mockRegistry.recordInvocationMetrics).toHaveBeenCalledWith('test-subprocess', expect.objectContaining({ success: true }));
    expect(result.formattedOutput).toBe('subprocess output');
  });

  it('routes to HttpAdapter by default when adapter is http', async () => {
    const executor = new Executor(mockRegistry);
    
    const mockSkill = {
      manifest: { name: 'test-http', adapter: 'http' }
    } as any;
    
    const result = await executor.execute(mockSkill, { query: 'test' });

    expect(mockRegistry.recordInvocationMetrics).toHaveBeenCalledWith('test-http', expect.objectContaining({ success: true }));
    // tests the JSON parsing format fallback
    expect(result.formattedOutput).toBe('http output');
  });

  it('routes to McpAdapter when skill.adapter is mcp', async () => {
    const executor = new Executor(mockRegistry);
    
    const mockSkill = {
      manifest: { name: 'test-mcp', adapter: 'mcp' }
    } as any;
    
    const result = await executor.execute(mockSkill, {});

    expect(mockRegistry.recordInvocationMetrics).toHaveBeenCalledWith('test-mcp', expect.objectContaining({ success: true }));
    expect(result.formattedOutput).toBe('mcp output'); // parsed from {"output":"..."}
  });

  it('formats error results properly', async () => {
    vi.mocked(SubprocessAdapter).mockImplementation(() => ({
      invoke: vi.fn().mockResolvedValue({ success: false, error: 'Command failed' })
    } as any));

    const executor = new Executor(mockRegistry);
    const mockSkill = {
      manifest: { name: 'test-fail', adapter: 'subprocess' }
    } as any;

    const result = await executor.execute(mockSkill, {});
    expect(result.formattedOutput).toBe('Error: Command failed');
  });

  it('returns CredentialMissingResult when a required credential env var is missing', async () => {
    delete process.env['REQUIRED_KEY'];

    const executor = new Executor(mockRegistry);
    const mockSkill = {
      manifest: {
        name: 'needs-key',
        adapter: 'http',
        credentials: [{ key: 'REQUIRED_KEY', label: 'Required Key', required: true }],
      },
    } as any;

    const result = await executor.execute(mockSkill, { query: 'test' });
    expect(result).toMatchObject({
      type: 'credential_missing',
      skillName: 'needs-key',
      missing: [{ key: 'REQUIRED_KEY' }],
    });
  });

  it('does not throw when all required credential env vars are set', async () => {
    process.env['REQUIRED_KEY'] = 'test-value';

    const executor = new Executor(mockRegistry);
    const mockSkill = {
      manifest: {
        name: 'has-key',
        adapter: 'http',
        credentials: [{ key: 'REQUIRED_KEY', label: 'Required Key', required: true }],
      },
    } as any;

    await expect(executor.execute(mockSkill, { query: 'test' })).resolves.toBeDefined();

    delete process.env['REQUIRED_KEY'];
  });

  it('does not throw for optional credentials that are missing', async () => {
    delete process.env['OPTIONAL_KEY'];

    const executor = new Executor(mockRegistry);
    const mockSkill = {
      manifest: {
        name: 'optional-key',
        adapter: 'http',
        credentials: [{ key: 'OPTIONAL_KEY', label: 'Optional Key', required: false }],
      },
    } as any;

    await expect(executor.execute(mockSkill, { query: 'test' })).resolves.toBeDefined();
  });

  it('records invocation metrics with latency and success on execution', async () => {
    const mockRecordMetrics = vi.fn();
    mockRegistry.recordInvocationMetrics = mockRecordMetrics;
    mockRegistry.recordInvocation = vi.fn();

    const executor = new Executor(mockRegistry);
    const mockSkill = {
      manifest: { name: 'test-metrics', adapter: 'subprocess' }
    } as any;

    await executor.execute(mockSkill, { query: 'test' });

    expect(mockRecordMetrics).toHaveBeenCalled();
    const call = mockRecordMetrics.mock.calls[0];
    expect(call[0]).toBe('test-metrics');
    expect(call[1]).toHaveProperty('success');
    expect(call[1]).toHaveProperty('latencyMs');
    expect(call[1]).toHaveProperty('tokenUsage');
  });

  it('records failed invocation metrics when adapter throws', async () => {
    const mockRecordMetrics = vi.fn();
    mockRegistry.recordInvocationMetrics = mockRecordMetrics;
    mockRegistry.recordInvocation = vi.fn();

    vi.mocked(SubprocessAdapter).mockImplementation(() => ({
      invoke: vi.fn().mockRejectedValue(new Error('adapter crash'))
    } as any));

    const executor = new Executor(mockRegistry);
    const mockSkill = {
      manifest: { name: 'test-crash', adapter: 'subprocess' }
    } as any;

    await expect(executor.execute(mockSkill, { query: 'test' })).rejects.toThrow('adapter crash');

    expect(mockRecordMetrics).toHaveBeenCalled();
    const call = mockRecordMetrics.mock.calls[0];
    expect(call[0]).toBe('test-crash');
    expect(call[1].success).toBe(false);
    expect(call[1]).toHaveProperty('latencyMs');
    expect(call[1].tokenUsage).toBe(0);
  });

  it('does not throw when credentials array is undefined', async () => {
    const executor = new Executor(mockRegistry);
    const mockSkill = {
      manifest: { name: 'no-creds', adapter: 'http', credentials: undefined },
    } as any;

    await expect(executor.execute(mockSkill, { query: 'test' })).resolves.toBeDefined();
  });

  it('accepts debug option in execute and emits debug lines', async () => {
    const mockRegistryLocal = {
      readInstructions: vi.fn(() => ''),
      recordInvocationMetrics: vi.fn(),
      recordFeedback: vi.fn(),
    };
    const mockChatClient = { chat: vi.fn(async () => 'node scripts/invoke.js') };

    const executor = new Executor(mockRegistryLocal as any, mockChatClient as any);

    const mockSkill = {
      manifest: {
        name: 'test-skill',
        description: 'Test',
        tags: [],
        version: '1',
        adapter: 'subprocess',
        hosting: 'local',
        auth: 'none',
        rating: 4,
        invocations: 0,
        enabled: true,
        llm_powered: false,
      },
      instructions: '',
      dirPath: '/tmp/nonexistent-skill-debug-test',
      rating: 4,
    } as any;

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    // execute will fail (no real script) but should still emit adapter debug line before failing
    await executor.execute(mockSkill, { query: 'test' }, { debug: true }).catch(() => {});

    spy.mockRestore();

    expect(writes.some(w => w.includes('[debug]') && w.includes('subprocess'))).toBe(true);
  });
});

describe('execute() with missing credentials', () => {
  it('returns CredentialMissingResult instead of throwing when env var is absent', async () => {
    delete process.env.MISSING_TEST_KEY_XYZ;

    const skill = {
      manifest: {
        name: 'test-skill',
        description: 'test',
        adapter: 'http' as const,
        credentials: [{ key: 'MISSING_TEST_KEY_XYZ', label: 'Get at https://example.com', required: true }],
        metadata: {},
      },
      dirPath: '/tmp',
    } as any;

    const registry = { recordInvocationMetrics: vi.fn(), recordFeedback: vi.fn(), readInstructions: vi.fn().mockReturnValue('') } as any;
    const executor = new Executor(registry);

    const result = await executor.execute(skill, { query: 'test' });

    expect(result).toMatchObject({
      type: 'credential_missing',
      skillName: 'test-skill',
      missing: [{ key: 'MISSING_TEST_KEY_XYZ' }],
    });
  });
});

describe('CredentialMissingResult type', () => {
  it('is exported from executor', () => {
    const result: import('../../src/index.js').CredentialMissingResult = {
      type: 'credential_missing',
      skillName: 'test-skill',
      missing: [{ key: 'TEST_KEY', label: 'Get at https://example.com' }],
    };
    expect(result.type).toBe('credential_missing');
    expect(result.skillName).toBe('test-skill');
    expect(result.missing[0].key).toBe('TEST_KEY');
  });
});

describe('extractCredentialErrors', () => {
  it('extracts key from "KEY environment variable is not set"', () => {
    const result = extractCredentialErrors('Error: XAI_API_KEY environment variable is not set.');
    expect(result).toEqual(['XAI_API_KEY']);
  });

  it('extracts key from "KEY is not set"', () => {
    const result = extractCredentialErrors('SERPER_API_KEY is not set');
    expect(result).toEqual(['SERPER_API_KEY']);
  });

  it('extracts key from "requires KEY"', () => {
    const result = extractCredentialErrors('--news requires SERPER_API_KEY');
    expect(result).toEqual(['SERPER_API_KEY']);
  });

  it('extracts multiple keys from comma-separated list', () => {
    const result = extractCredentialErrors(
      '--news requires SERPER_API_KEY, TAVILY_API_KEY, SERPAPI_API_KEY, YOU_API_KEY, or SEARXNG_INSTANCE_URL'
    );
    expect(result).toEqual(['SERPER_API_KEY', 'TAVILY_API_KEY', 'SERPAPI_API_KEY', 'YOU_API_KEY', 'SEARXNG_INSTANCE_URL']);
  });

  it('extracts key from "missing KEY"', () => {
    const result = extractCredentialErrors('Error: missing OPENAI_API_KEY');
    expect(result).toEqual(['OPENAI_API_KEY']);
  });

  it('extracts key from "needs KEY"', () => {
    const result = extractCredentialErrors('This skill needs GITHUB_TOKEN to work');
    expect(result).toEqual(['GITHUB_TOKEN']);
  });

  it('extracts key with _URL suffix', () => {
    const result = extractCredentialErrors('requires SEARXNG_INSTANCE_URL');
    expect(result).toEqual(['SEARXNG_INSTANCE_URL']);
  });

  it('extracts key with _SECRET suffix', () => {
    const result = extractCredentialErrors('AWS_SECRET_KEY is not set');
    expect(result).toEqual(['AWS_SECRET_KEY']);
  });

  it('returns empty array when no credential pattern matches', () => {
    const result = extractCredentialErrors('Connection timeout after 30s');
    expect(result).toEqual([]);
  });

  it('deduplicates keys mentioned multiple times', () => {
    const result = extractCredentialErrors('XAI_API_KEY is not set. Please set XAI_API_KEY.');
    expect(result).toEqual(['XAI_API_KEY']);
  });

  it('extracts from JSON error output', () => {
    const json = JSON.stringify({ report: 'Search failed: Error: XAI_API_KEY environment variable is not set.\n', status: 'error' });
    const result = extractCredentialErrors(json);
    expect(result).toEqual(['XAI_API_KEY']);
  });

  it('only scans first 2000 chars', () => {
    const padding = 'x'.repeat(2100);
    const result = extractCredentialErrors(padding + 'XAI_API_KEY is not set');
    expect(result).toEqual([]);
  });
});
