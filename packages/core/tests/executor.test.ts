import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Executor } from '../src/executor.js';
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

  it('throws before invoking when a required credential env var is missing', async () => {
    delete process.env['REQUIRED_KEY'];

    const executor = new Executor(mockRegistry);
    const mockSkill = {
      manifest: {
        name: 'needs-key',
        adapter: 'http',
        credentials: [{ key: 'REQUIRED_KEY', label: 'Required Key', required: true }],
      },
    } as any;

    await expect(executor.execute(mockSkill, { query: 'test' }))
      .rejects.toThrow('REQUIRED_KEY');
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
});

describe('CredentialMissingResult type', () => {
  it('is exported from executor', () => {
    const result: import('../../src/executor.js').CredentialMissingResult = {
      type: 'credential_missing',
      skillName: 'test-skill',
      missing: [{ key: 'TEST_KEY', label: 'Get at https://example.com' }],
    };
    expect(result.type).toBe('credential_missing');
    expect(result.skillName).toBe('test-skill');
    expect(result.missing[0].key).toBe('TEST_KEY');
  });
});
