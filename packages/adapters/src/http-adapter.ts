import type { LoadedSkill } from '@agentoctopus/registry';
import type { Adapter, AdapterResult } from './adapter.js';

export class HttpAdapter implements Adapter {
  async invoke(skill: LoadedSkill, input: Record<string, unknown>): Promise<AdapterResult> {
    const { endpoint, auth } = skill.manifest;

    if (!endpoint) {
      return { success: false, error: 'Skill has no endpoint configured.' };
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'AgentOctopus/0.1.0',
    };

    // Inject API key from env if auth is api_key
    if (auth === 'api_key') {
      const envKey = `SKILL_${skill.manifest.name.toUpperCase().replace(/-/g, '_')}_API_KEY`;
      const apiKey = process.env[envKey];
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
    }

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
      });

      const rawText = await response.text();

      if (!response.ok) {
        return {
          success: false,
          error: `HTTP ${response.status}: ${rawText}`,
          rawText,
        };
      }

      let data: unknown;
      try {
        data = JSON.parse(rawText);
      } catch {
        data = rawText;
      }

      return { success: true, data, rawText };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
