import type { LoadedSkill } from '@octopus/registry';
import type { Adapter, AdapterResult } from './adapter.js';

/**
 * MCP adapter stub — Phase 2 implementation.
 * Currently returns an informative placeholder.
 */
export class McpAdapter implements Adapter {
  async invoke(_skill: LoadedSkill, _input: Record<string, unknown>): Promise<AdapterResult> {
    return {
      success: false,
      error:
        'MCP adapter is not yet implemented. This skill requires an MCP server connection (coming in Phase 2).',
    };
  }
}
