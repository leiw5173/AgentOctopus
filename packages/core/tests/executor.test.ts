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
    
    expect(mockRegistry.recordInvocation).toHaveBeenCalledWith('test-subprocess');
    expect(result.formattedOutput).toBe('subprocess output');
  });

  it('routes to HttpAdapter by default when adapter is http', async () => {
    const executor = new Executor(mockRegistry);
    
    const mockSkill = {
      manifest: { name: 'test-http', adapter: 'http' }
    } as any;
    
    const result = await executor.execute(mockSkill, { query: 'test' });
    
    expect(mockRegistry.recordInvocation).toHaveBeenCalledWith('test-http');
    // tests the JSON parsing format fallback
    expect(result.formattedOutput).toBe('http output');
  });

  it('routes to McpAdapter when skill.adapter is mcp', async () => {
    const executor = new Executor(mockRegistry);
    
    const mockSkill = {
      manifest: { name: 'test-mcp', adapter: 'mcp' }
    } as any;
    
    const result = await executor.execute(mockSkill, {});
    
    expect(mockRegistry.recordInvocation).toHaveBeenCalledWith('test-mcp');
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
});
