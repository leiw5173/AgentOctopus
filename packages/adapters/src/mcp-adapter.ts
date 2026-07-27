import type { Adapter, AdapterInput, AdapterInvocationContext, AdapterResult } from './adapter.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { SandboxMcpTransport } from './sandbox-mcp-transport.js';

/** Read the SKILL.md body (below the frontmatter) without adding a gray-matter dependency. */
function readSkillBody(dirPath: string): string {
  try {
    const raw = fs.readFileSync(path.join(dirPath, 'SKILL.md'), 'utf-8');
    // Strip YAML frontmatter (--- ... ---)
    const match = raw.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
    return (match ? match[1] : raw).trim();
  } catch {
    return '';
  }
}

const MCP_CONNECT_TIMEOUT_MS = 15_000;

/**
 * MCP adapter converged onto the single sandbox execution boundary
 * (Plan 5 Task 5). The MCP child now runs INSIDE the sandbox over a
 * persistent duplex `SandboxProcess` via `SandboxMcpTransport`, spawned
 * through the skill-bound `context.sandbox` port. There is NO host stdio
 * child, NO host process-kill cleanup, and NO inherited host environment — the
 * guest receives only the minimal env the sandbox session provisions.
 */
export class McpAdapter implements Adapter {
  async invoke(input: AdapterInput, context: AdapterInvocationContext): Promise<AdapterResult> {
    const { skill } = input;
    const toolInput = input.input;
    let transport: SandboxMcpTransport | undefined;
    let client: Client | undefined;
    try {
      // Determine the MCP command to run:
      // 1. manifest.endpoint (explicit)
      // 2. metadata.mcp_command (e.g. "npx mcp-remote https://mcp.zu.lk/mcp")
      // 3. metadata.mcp_url → "npx mcp-remote <url>"
      // 4. SKILL.md body (fallback, treated as command — lazy loaded)
      const meta = skill.manifest.metadata as Record<string, unknown> | undefined;
      const skillInstructionsFallback = readSkillBody(skill.dirPath) || undefined;
      const mcpCommand = skill.manifest.endpoint
        || (meta?.mcp_command as string)
        || (meta?.mcp_url ? `npx mcp-remote ${meta.mcp_url}` : undefined)
        || skillInstructionsFallback;

      if (!mcpCommand) {
        return { success: false, error: 'No command or endpoint specified for MCP skill' };
      }

      // The resolved command is the GUEST command array, executed inside the
      // sandbox — never on the host.
      const command = mcpCommand.trim().split(/\s+/);

      transport = new SandboxMcpTransport({
        port: context.sandbox,
        command,
        timeoutMs: context.timeoutMs,
      });

      client = new Client(
        { name: 'agent-octopus-mcp-client', version: '0.1.0' },
        { capabilities: {} }
      );

      // Connect with timeout — MCP OAuth flows can hang if no one completes auth
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('MCP_CONNECTION_TIMEOUT')), MCP_CONNECT_TIMEOUT_MS)
        ),
      ]);

      // Assume MCP server defines exactly one tool matching the skill name,
      // or we just call the first tool available if it matches
      const toolsResult = await client.listTools();
      const tool = toolsResult.tools.find((t) => t.name === skill.manifest.name) || toolsResult.tools[0];

      if (!tool) {
        await client.close();
        await transport.close();
        return { success: false, error: `No tools found on MCP server for ${skill.manifest.name}` };
      }

      // Execute the tool
      const result = await client.callTool({
        name: tool.name,
        arguments: toolInput,
      });

      await client.close();
      await transport.close();

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
      // Ensure the sandbox session/process is cleaned up even when MCP
      // initialization or the tool call fails — no host process scan.
      try {
        await client?.close();
      } catch { /* ignore */ }
      try {
        await transport?.close();
      } catch { /* ignore */ }

      const msg = err.message || String(err);

      // Provide helpful guidance for common MCP errors
      if (msg.includes('MCP_CONNECTION_TIMEOUT')) {
        return {
          success: false,
          error: `MCP connection timed out after ${MCP_CONNECT_TIMEOUT_MS / 1000}s. This skill likely requires OAuth authentication.\n\n  To authenticate, run the MCP command directly in your terminal:\n    ${skill.manifest.metadata?.mcp_command || 'npx mcp-remote ' + (skill.manifest.metadata as any)?.mcp_url}\n\n  Then complete the OAuth flow in your browser before retrying.`,
        };
      }

      return {
        success: false,
        error: `MCP Adapter failed: ${msg}`,
      };
    }
  }
}
