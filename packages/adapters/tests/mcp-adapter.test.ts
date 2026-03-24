import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpAdapter } from '../src/mcp-adapter.js';

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: vi.fn().mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [{ name: 'test-mcp-tool', description: 'desc', inputSchema: {} }]
      }),
      callTool: vi.fn().mockResolvedValue({
        isError: false,
        content: [{ type: 'text', text: 'mcp-tool-output' }]
      }),
      close: vi.fn().mockResolvedValue(undefined),
    }))
  };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  return {
    StdioClientTransport: vi.fn()
  };
});

describe('McpAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invokes an MCP tool matching the skill name', async () => {
    const adapter = new McpAdapter();
    const mockSkill = {
      manifest: { name: 'test-mcp-tool', endpoint: 'npx my-mcp-server' }
    } as any;

    const result = await adapter.invoke(mockSkill, { arg: 'val' });
    
    expect(result.success).toBe(true);
    expect(result.rawText).toBe('mcp-tool-output');
  });

  it('fails if no command or endpoint is provided', async () => {
    const adapter = new McpAdapter();
    const mockSkill = {
      manifest: { name: 'test-mcp-tool' }
    } as any;

    const result = await adapter.invoke(mockSkill, { arg: 'val' });
    
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No command or endpoint/);
  });
});
