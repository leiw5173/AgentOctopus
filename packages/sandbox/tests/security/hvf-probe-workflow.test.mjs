import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(path.resolve(here, '../../../../.github/workflows/sandbox-security.yml'), 'utf8');
const probeStep = workflow.indexOf('      - name: Probe Hypervisor.framework availability\n');
const scriptStart = workflow.indexOf('        run: |\n', probeStep) + '        run: |\n'.length;
const scriptEnd = workflow.indexOf('\n  vm-lane:', scriptStart);
if (probeStep < 0 || scriptStart < '        run: |\n'.length || scriptEnd < 0) {
  throw new Error('HVF probe script not found');
}
const probeScript = workflow.slice(scriptStart, scriptEnd)
  .split('\n').map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n');

function runProbe({ signExit, probeExit }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'oct-hvf-probe-'));
  try {
    const bin = path.join(dir, 'bin');
    const output = path.join(dir, 'output');
    mkdirSync(bin);
    const compiler = path.join(bin, 'cc');
    writeFileSync(compiler, '#!/bin/sh\nout=""\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = -o ]; then shift; out="$1"; fi\n  shift\ndone\nprintf "#!/bin/sh\\nexit %s\\n" "$PROBE_EXIT" > "$out"\nchmod +x "$out"\n');
    chmodSync(compiler, 0o755);
    const signer = path.join(bin, 'codesign');
    writeFileSync(signer, '#!/bin/sh\nexit "$SIGN_EXIT"\n');
    chmodSync(signer, 0o755);
    const isolatedScript = probeScript
      .replaceAll('/tmp/hvf_probe', path.join(dir, 'hvf_probe'))
      .replaceAll('/tmp/hvf_ent.plist', path.join(dir, 'hvf_ent.plist'));
    const result = spawnSync('bash', ['-e', '-c', isolatedScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_OUTPUT: output,
        PROBE_EXIT: String(probeExit),
        SIGN_EXIT: String(signExit),
      },
    });
    let emitted = '';
    try { emitted = readFileSync(output, 'utf8'); } catch { /* no output on fail-closed path */ }
    return { status: result.status, emitted };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('physical-runner HVF probe workflow', () => {
  it('reports available after a signed, successful VM create', () => {
    expect(runProbe({ signExit: 0, probeExit: 0 })).toEqual({ status: 0, emitted: 'hvf=available\n' });
  });

  it('fails without declaring HVF unavailable when codesign fails', () => {
    const result = runProbe({ signExit: 1, probeExit: 1 });
    expect(result.status).not.toBe(0);
    expect(result.emitted).toBe('');
  });

  it('fails on a signed probe error on a physical runner', () => {
    const result = runProbe({ signExit: 0, probeExit: 1 });
    expect(result.status).not.toBe(0);
    expect(result.emitted).toBe('');
  });
});
