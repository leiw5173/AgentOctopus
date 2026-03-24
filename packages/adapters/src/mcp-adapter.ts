import type { LoadedSkill } from '@octopus/registry';
import type { Adapter, AdapterResult } from './adapter.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
// SSE transport could be imported here if needed: 
// import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

export class McpAdapter implements Adapter {
  async invoke(skill: LoadedSkill, input: Record<string, unknown>): Promise<AdapterResult> {
    try {
      const commandLine = skill.manifest.endpoint || skill.instructions;
      if (!commandLine) {
        return { success: false, error: 'No command or endpoint specified for MCP skill' };
      }

      // Phase 2 MVP: Stdio transport
      // Parse command line (very naive split for MVP)
      const parts = commandLine.trim().split(/\s+/);
      const command = parts[0];
      const args = parts.slice(1);

      const transport = new StdioClientTransport({
        command,
        args,
        env: process.env as Record<string, string>,
      });

      const client = new Client(
        { name: 'agent-octopus-mcp-client', version: '0.1.0' },
        { capabilities: {} }
      );

      await client.connect(transport);

      // Assume MCP server defines exactly one tool matching the skill name, 
      // or we just call the first tool available if it matches
      const toolsResult = await client.listTools();
      const tool = toolsResult.tools.find((t) => t.name === skill.manifest.name) || toolsResult.tools[0];

      if (!tool) {
        await client.close();
        return { success: false, error: `No tools found on MCP server for ${skill.manifest.name}` };
      }

      // Execute the tool
      const result = await client.callTool({
        name: tool.name,
        arguments: input,
      });

      await client.close();

      // Format result
      if (result.isError) {
        return { success: false, error: `MCP Tool Error: ${JSON.stringify(result.content)}` };
      }

      const content = result.content as any[];
      const textOutput = content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');

      return {
        success: true,
        data: result.content,
        rawText: textOutput,
      };
    } catch (err: any) {
      return {
        success: false,
        error: `MCP Adapter failed: ${err.message || err}`,
      };
    }
  }
}
