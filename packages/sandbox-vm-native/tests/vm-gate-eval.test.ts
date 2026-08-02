import { describe, it, expect } from 'vitest';
import { evaluateG1, evaluateG2, buildHelperArgv, BOOTSTRAP_PATH } from '../scripts/vm-gate-eval.mjs';

describe('evaluateG1', () => {
  it('returns NO-GO when stdout lacks G1-DONE (even if no sentinel present)', () => {
    const result = evaluateG1('some output without marker\n', 'SENTINEL');
    expect(result.status).toBe('NO-GO');
    expect(result.reason).toMatch(/G1-DONE/);
  });

  it('returns NO-GO when the sentinel value appears in stdout (leak)', () => {
    const result = evaluateG1('G1-DONE\nSENTINEL-VALUE-LEAK\n', 'SENTINEL-VALUE-LEAK');
    expect(result.status).toBe('NO-GO');
    expect(result.reason).toMatch(/leaked/);
  });

  it('returns GO only when G1-DONE present AND sentinel absent', () => {
    const result = evaluateG1('NOT-FOUND\nG1-DONE\n', 'SENTINEL');
    expect(result.status).toBe('GO');
    expect(result.reason).toMatch(/unreadable/);
  });
});

describe('evaluateG2', () => {
  it('returns NO-GO when canaryReceivedConnection is true', () => {
    const result = evaluateG2('G2-DONE\n', true);
    expect(result.status).toBe('NO-GO');
    expect(result.reason).toMatch(/received/);
  });

  it('returns NO-GO when CONNECT-OK appears', () => {
    const result = evaluateG2('CONNECT-OK\nG2-DONE\n', false);
    expect(result.status).toBe('NO-GO');
    expect(result.reason).toMatch(/1\.1\.1\.1/);
  });

  it('returns NO-GO when G2-DONE is absent', () => {
    const result = evaluateG2('CONNECT-FAIL\n', false);
    expect(result.status).toBe('NO-GO');
    expect(result.reason).toMatch(/G2-DONE/);
  });

  it('returns GO only on G2-DONE + no connect-ok + canary untouched', () => {
    const result = evaluateG2('CONNECT-FAIL\nG2-DONE\n', false);
    expect(result.status).toBe('GO');
    expect(result.reason).toMatch(/could not reach/);
  });
});

describe('buildHelperArgv', () => {
  it('produces [helperPath, helperSpecToken] where the token decodes to a spec with nested bootstrapArgv', async () => {
    const argv = await buildHelperArgv('/prebuilds/linux-x64/sandbox-vm-helper', {
      rootfsImg: '/prebuilds/linux-x64/rootfs.img',
      skillBlockImg: '/prebuilds/linux-x64/skill.img',
      caBlockImg: '/prebuilds/linux-x64/ca.img',
      vsockPort: 4242,
      vsockHostSocket: '/tmp/octopus-gate-vsock.sock',
      cpus: 1,
      memMib: 512,
      launchSpecBlob: 'INNER-SPEC-BLOB',
    });
    expect(argv).toHaveLength(2);
    expect(argv[0]).toBe('/prebuilds/linux-x64/sandbox-vm-helper');
    const spec = JSON.parse(Buffer.from(argv[1], 'base64url').toString('utf8'));
    expect(spec.rootfsPath).toBe('/prebuilds/linux-x64/rootfs.img');
    expect(spec.skillBlockPath).toBe('/prebuilds/linux-x64/skill.img');
    expect(spec.caBlockPath).toBe('/prebuilds/linux-x64/ca.img');
    expect(spec.vsockPort).toBe(4242);
    expect(spec.vsockHostSocket).toBe('/tmp/octopus-gate-vsock.sock');
    expect(spec.cpus).toBe(1);
    expect(spec.memMib).toBe(512);
    expect(spec.bootstrapPath).toBe(BOOTSTRAP_PATH);
    // libkrun supplies argv[0]=bootstrapPath; bootstrapArgv carries only the blob.
    expect(spec.bootstrapArgv).toEqual(['INNER-SPEC-BLOB']);
    expect(spec.bootstrapArgv[0]).not.toBe(spec.bootstrapPath);
    expect(spec.trustedEnv).toEqual([]);
  });
});
