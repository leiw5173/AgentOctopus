import type { LoadedSkill } from '@agentoctopus/registry';
import type { Adapter, AdapterResult } from './adapter.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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

export class McpAdapter implements Adapter {
  async invoke(skill: LoadedSkill, input: Record<string, unknown>): Promise<AdapterResult> {
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

      // Clean up stale mcp-remote processes that may have left ports occupied
      this.cleanupStaleMcpProcesses();

      // Phase 2 MVP: Stdio transport
      // Parse command line (very naive split for MVP)
      const parts = mcpCommand.trim().split(/\s+/);
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
      const msg = err.message || String(err);

      // Provide helpful guidance for common MCP errors
      if (msg.includes('MCP_CONNECTION_TIMEOUT')) {
        return {
          success: false,
          error: `MCP connection timed out after ${MCP_CONNECT_TIMEOUT_MS / 1000}s. This skill likely requires OAuth authentication.\n\n  To authenticate, run the MCP command directly in your terminal:\n    ${skill.manifest.metadata?.mcp_command || 'npx mcp-remote ' + (skill.manifest.metadata as any)?.mcp_url}\n\n  Then complete the OAuth flow in your browser before retrying.`,
        };
      }

      if (msg.includes('EADDRINUSE')) {
        return {
          success: false,
          error: `MCP OAuth callback port is already in use. A previous MCP session may not have cleaned up.\n\n  Try killing stale mcp-remote processes:\n    pkill -f mcp-remote\n\n  Then retry.`,
        };
      }

      return {
        success: false,
        error: `MCP Adapter failed: ${msg}`,
      };
    }
  }

  /**
   * Kill stale mcp-remote processes that may be holding ports from
   * previous invocations that timed out during OAuth.
   */
  private cleanupStaleMcpProcesses(): void {
    try {
      // Find mcp-remote processes older than 30 seconds
      cp.execSync('pkill -f --older-than 30s mcp-remote 2>/dev/null || true', {
        timeout: 2000,
        stdio: 'pipe',
      });
    } catch {
      // pkill not available or no matching processes — ignore
    }
  }
}
