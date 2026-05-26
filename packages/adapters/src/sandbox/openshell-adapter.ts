import type { LoadedSkill } from '@agentoctopus/registry';
import type { Adapter, AdapterResult } from '../adapter.js';
import { SubprocessAdapter } from '../subprocess-adapter.js';

/**
 * OpenShell sandbox adapter: pass-through to local execution.
 * This is the default "sandbox" when no real isolation is desired.
 * Uses the existing SubprocessAdapter under the hood.
 */
export class OpenShellAdapter implements Adapter {
  private subprocess = new SubprocessAdapter();

  async invoke(skill: LoadedSkill, input: Record<string, unknown>): Promise<AdapterResult> {
    return this.subprocess.invoke(skill, input);
  }
}
