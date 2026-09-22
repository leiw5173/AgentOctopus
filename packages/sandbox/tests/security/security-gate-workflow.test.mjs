import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
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

  it('rejects an unavailable-HVF skip on the physical runner', () => {
    expect(gateResult({ HVF_AVAILABLE: 'unavailable', VM_RESULT: 'skipped' }).status).not.toBe(0);
  });

  it('allows a fork to skip all self-hosted Linux and VM jobs', () => {
    expect(gateResult({ FORK_PR: 'true', LINUX_RESULT: 'skipped', HVF_PROBE_RESULT: 'skipped', HVF_AVAILABLE: '', VM_RESULT: 'skipped' }).status).toBe(0);
  });

  it('rejects a fork that ran the self-hosted VM probe', () => {
    expect(gateResult({ FORK_PR: 'true', LINUX_RESULT: 'skipped', HVF_AVAILABLE: 'unavailable', VM_RESULT: 'skipped' }).status).not.toBe(0);
  });

  it('keeps fork PRs off both self-hosted VM jobs', () => {
    const guard = "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository";
    const probeJob = workflow.split('  vm-hvf-probe:\n')[1]?.split('  vm-lane:\n')[0];
    const vmJob = workflow.split('  vm-lane:\n')[1]?.split('  security-gate:\n')[0];
    expect(probeJob).toContain(`if: ${guard}`);
    expect(vmJob).toContain(guard);
  });
});


describe('sandbox workflow scheduling', () => {
  it('keeps direct master security runs separate from Release Preflight calls', () => {
    const template = workflow.match(/concurrency:\n  group: (.+)\n  cancel-in-progress: true/)?.[1];
    expect(template).toBeDefined();
    const groupFor = (caller) => template
      .replaceAll('${{ github.workflow }}', caller)
      .replaceAll('${{ github.ref }}', 'refs/heads/master');
    expect(groupFor('Sandbox Security')).not.toBe(groupFor('Release Preflight'));
  });
});


describe('privileged runner staging', () => {
  it('creates the exact temp directory exported to later steps', () => {
    const marker = '      - name: Rescue stale in-workspace tmpfs before checkout\n';
    const step = workflow.indexOf(marker);
    const start = workflow.indexOf('        run: |\n', step) + '        run: |\n'.length;
    const end = workflow.indexOf('          ws=', start);
    if (step < 0 || start < '        run: |\n'.length || end < 0) throw new Error('pre-checkout rescue not found');
    const script = workflow.slice(start, end).split('\n')
      .map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'oct-staging-'));
    try {
      const mkdir = path.join(dir, 'mkdir');
      writeFileSync(mkdir, '#!/bin/sh\nprintf "%s\\n" "$@" > "$MKDIR_ARGS"\n');
      chmodSync(mkdir, 0o755);
      const args = path.join(dir, 'mkdir.args');
      const result = spawnSync('bash', ['-e', '-c', script], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TMPDIR: '/tmp/unrelated', GITHUB_ENV: path.join(dir, 'env'), MKDIR_ARGS: args },
      });
      expect(result.status).toBe(0);
      expect(readFileSync(path.join(dir, 'env'), 'utf8')).toBe('TMPDIR=/var/tmp/oct-tmp\n');
      expect(readFileSync(args, 'utf8')).toBe('-p\n/var/tmp/oct-tmp\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails early when the required disk-backed staging directory cannot be created', () => {
    const step = workflow.indexOf('      - name: Rescue stale in-workspace tmpfs before checkout\n');
    const start = workflow.indexOf('        run: |\n', step) + '        run: |\n'.length;
    const script = workflow.slice(start, workflow.indexOf('          ws=', start)).split('\n')
      .map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'oct-staging-denied-'));
    try {
      const mkdir = path.join(dir, 'mkdir');
      writeFileSync(mkdir, '#!/bin/sh\nexit 1\n');
      chmodSync(mkdir, 0o755);
      const result = spawnSync('bash', ['-e', '-c', script], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TMPDIR: '/tmp/unrelated', GITHUB_ENV: path.join(dir, 'env') },
      });
      expect(result.status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
