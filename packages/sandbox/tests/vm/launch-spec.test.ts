// packages/sandbox/tests/vm/launch-spec.test.ts
import { describe, it, expect } from 'vitest';
import { encodeLaunchSpec, validateWorkloadSpec, MAX_LAUNCH_SPEC_DECODED_BYTES } from '../../src/vm/launch-spec.js';
import { LaunchSpecTooLargeError, RunSpecError } from '../../src/vm/errors.js';

const good = {
  executable: 'node',
  argv: ['node', '-e', 'console.log(1)'],
  cwd: '/skill',
  env: ['PATH=/usr/bin', 'HTTP_PROXY=http://127.0.0.1:1234'],
  allowedExecutables: { node: '/usr/bin/node' },
};

describe('launch-spec encoding', () => {
  it('encodes to a NUL-free base64url blob', () => {
    const { blob, cborBytes } = encodeLaunchSpec(good);
    expect(blob).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no +/=
    expect(blob).not.toContain('\x00');
    expect(cborBytes).toBeLessThanOrEqual(MAX_LAUNCH_SPEC_DECODED_BYTES);
  });

  it('rejects a NUL byte in any string', () => {
    expect(() => encodeLaunchSpec({ ...good, executable: 'no\x00de' })).toThrow(RunSpecError);
    expect(() => encodeLaunchSpec({ ...good, argv: ['no\x00de'] })).toThrow(RunSpecError);
    expect(() => encodeLaunchSpec({ ...good, cwd: '/skill\x00' })).toThrow(RunSpecError);
    expect(() => encodeLaunchSpec({ ...good, env: ['PATH=/usr\x00bin'] })).toThrow(RunSpecError);
  });

  it('rejects env entries not matching ^[^\\x00=]+=[^\\x00]*$', () => {
    expect(() => encodeLaunchSpec({ ...good, env: ['=novalue'] })).toThrow(RunSpecError); // empty key
    expect(() => encodeLaunchSpec({ ...good, env: ['KEY=val=ue'] })).not.toThrow(); // = in value is allowed
    expect(() => encodeLaunchSpec({ ...good, env: ['BADKEY'] })).toThrow(RunSpecError); // no =
  });

  it('rejects allowedExecutables values that are not absolute paths', () => {
    expect(() => encodeLaunchSpec({ ...good, allowedExecutables: { node: 'node' } })).toThrow(RunSpecError);
    expect(() => encodeLaunchSpec({ ...good, allowedExecutables: { node: 'relative/path' } })).toThrow(RunSpecError);
  });

  it('throws LaunchSpecTooLargeError(decoded) when CBOR exceeds 65536 bytes', () => {
    const huge = 'x'.repeat(70000);
    expect(() => encodeLaunchSpec({ ...good, argv: ['node', huge] })).toThrow(LaunchSpecTooLargeError);
  });

  it('does not throw when CBOR is exactly at the decoded limit boundary', () => {
    // A spec just under 65536 decoded bytes should succeed.
    // Each 'x' char in argv contributes 1 byte to the CBOR text string + 1-2 header bytes.
    // We need the total CBOR to be <= 65536 bytes.
    // Base overhead is ~130 bytes for the map structure, so 65000 chars of 'x' is safe.
    const atLimit = 'x'.repeat(65000);
    const result = encodeLaunchSpec({ ...good, argv: ['node', atLimit] });
    expect(result.cborBytes).toBeLessThanOrEqual(MAX_LAUNCH_SPEC_DECODED_BYTES);
  });

  it('produces deterministic output (byte-identical on re-encode)', () => {
    const a = encodeLaunchSpec(good);
    const b = encodeLaunchSpec(good);
    expect(a.blob).toBe(b.blob);
    expect(a.cborBytes).toBe(b.cborBytes);
  });

  it('produces deterministic output with reordered allowedExecutables keys', () => {
    const ordered = { ...good, allowedExecutables: { node: '/usr/bin/node', sh: '/bin/sh' } };
    const reversed = { ...good, allowedExecutables: { sh: '/bin/sh', node: '/usr/bin/node' } };
    const a = encodeLaunchSpec(ordered);
    const b = encodeLaunchSpec(reversed);
    // Canonical CBOR sorts map keys, so both must produce identical bytes.
    expect(a.blob).toBe(b.blob);
  });

  it('validateWorkloadSpec passes for a good spec', () => {
    expect(() => validateWorkloadSpec(good)).not.toThrow();
  });

  it('validateWorkloadSpec throws on NUL in allowedExecutables key', () => {
    expect(() =>
      validateWorkloadSpec({ ...good, allowedExecutables: { 'no\x00de': '/usr/bin/node' } }),
    ).toThrow(RunSpecError);
  });

  it('rejects NUL in allowedExecutables value', () => {
    expect(() =>
      encodeLaunchSpec({ ...good, allowedExecutables: { node: '/usr/bin/\x00node' } }),
    ).toThrow(RunSpecError);
  });
});
