import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(path.resolve(here, '../../../../.github/workflows/sandbox-security.yml'), 'utf8');
const gateStep = workflow.indexOf('      - name: Require every security lane\n');
const scriptStart = workflow.indexOf('        run: |\n', gateStep) + '        run: |\n'.length;
if (gateStep < 0 || scriptStart < '        run: |\n'.length) throw new Error('security gate script not found');
const gateScript = workflow.slice(scriptStart).split('\n').map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n');

function gateResult(overrides = {}) {
  return spawnSync('bash', ['-e', '-c', gateScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOSTED_RESULT: 'success',
      PRODUCER_RESULT: 'success',
      LINUX_RESULT: 'success',
      MACOS_RESULT: 'success',
      WINDOWS_RESULT: 'success',
      HVF_PROBE_RESULT: 'success',
      HVF_AVAILABLE: 'available',
      VM_RESULT: 'success',
      FORK_PR: 'false',
      ...overrides,
    },
  });
}

describe('sandbox security-gate workflow', () => {
  it('accepts all executed security lanes', () => {
    expect(gateResult().status).toBe(0);
  });

  it('rejects a failed producer even if dependent lanes were skipped', () => {
    expect(gateResult({ PRODUCER_RESULT: 'failure', LINUX_RESULT: 'skipped', VM_RESULT: 'skipped' }).status).not.toBe(0);
  });

  it('rejects a Linux skip on a same-repository PR', () => {
    expect(gateResult({ LINUX_RESULT: 'skipped' }).status).not.toBe(0);
  });

  it('rejects a VM skip when hypervisor probing succeeded and is available', () => {
    expect(gateResult({ VM_RESULT: 'skipped' }).status).not.toBe(0);
  });

  it('rejects a VM skip when the hypervisor probe failed', () => {
    expect(gateResult({ HVF_PROBE_RESULT: 'failure', HVF_AVAILABLE: '', VM_RESULT: 'skipped' }).status).not.toBe(0);
  });

  it('allows the documented fork and unavailable-hypervisor skips', () => {
    expect(gateResult({ FORK_PR: 'true', LINUX_RESULT: 'skipped', HVF_AVAILABLE: 'unavailable', VM_RESULT: 'skipped' }).status).toBe(0);
  });
});
