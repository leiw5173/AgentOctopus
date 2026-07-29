// packages/sandbox/src/vm/launch-spec.ts
// Pure-logic construction + validation of VmWorkloadSpec, canonical-CBOR encoding,
// base64url wrapping, NUL rejection, and dual size caps.
//
// No external CBOR dependency: the `cbor` npm package (v10.x) has a broken
// `encodeCanonical` — it only emits the map header byte for plain objects and
// does not sort map keys. Because the LaunchSpec schema is fixed (6 fields,
// all text strings / arrays / maps), a hand-rolled canonical CBOR encoder is
// tractable and produces byte-deterministic output per RFC 8949 §4.2.1.

import { LaunchSpecTooLargeError, RunSpecError } from './errors.js';
import type { VmWorkloadSpec } from './types.js';

export const MAX_LAUNCH_SPEC_DECODED_BYTES = 65536;
export const MAX_LAUNCH_SPEC_ARGV_BYTES = 98304;

const ENV_RE = /^[^\x00=]+=[^\x00]*$/;
const ABSOLUTE_RE = /^\/[^]*$/; // starts with /, non-empty after

function hasNul(s: string): boolean {
  return s.indexOf('\x00') !== -1;
}

// ---------------------------------------------------------------------------
// Canonical CBOR encoder (RFC 8949 §4.2.1 deterministic encoding)
// ---------------------------------------------------------------------------

/**
 * Appends a CBOR head (major type + argument) to `out`, using the minimal
 * length form per RFC 8949 §3.1.
 *
 * Major types:
 *   0 = unsigned integer
 *   2 = byte string
 *   3 = text string
 *   4 = array
 *   5 = map
 */
function writeHead(out: number[], majorType: number, arg: number): void {
  const mt = majorType << 5; // major type in top 3 bits
  if (arg < 24) {
    out.push(mt | arg);
  } else if (arg <= 0xff) {
    out.push(mt | 24, arg);
  } else if (arg <= 0xffff) {
    out.push(mt | 25, (arg >> 8) & 0xff, arg & 0xff);
  } else if (arg <= 0xffffffff) {
    out.push(
      mt | 26,
      (arg >>> 24) & 0xff,
      (arg >> 16) & 0xff,
      (arg >> 8) & 0xff,
      arg & 0xff,
    );
  } else {
    // 64-bit (only needed if arg > 2^32-1; not expected for LaunchSpec sizes)
    const hi = Math.floor(arg / 0x100000000);
    const lo = arg >>> 0;
    out.push(
      mt | 27,
      (hi >>> 24) & 0xff,
      (hi >> 16) & 0xff,
      (hi >> 8) & 0xff,
      hi & 0xff,
      (lo >>> 24) & 0xff,
      (lo >> 16) & 0xff,
      (lo >> 8) & 0xff,
      lo & 0xff,
    );
  }
}

function encodeTextString(out: number[], s: string): void {
  // UTF-8 encode: values 0-127 are one byte, others use TextEncoder
  const bytes = Buffer.from(s, 'utf8');
  writeHead(out, 3, bytes.length); // major type 3 = text string
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
}

function encodeUint(out: number[], n: number): void {
  writeHead(out, 0, n); // major type 0 = unsigned integer
}

function encodeTextStringArray(out: number[], arr: string[]): void {
  writeHead(out, 4, arr.length); // major type 4 = array, definite length
  for (const s of arr) encodeTextString(out, s);
}

function encodeStringMap(out: number[], map: Record<string, string>): void {
  const entries = Object.entries(map);
  // RFC 8949 §4.2.1: sort keys by the byte representation of the CBOR-encoded
  // key. For text strings this is: shorter length first, then bytewise.
  // Since the CBOR head includes the length, sorting by (encoded-key-bytes)
  // is equivalent to sorting by (utf8-length, then utf8-bytes).
  entries.sort((a, b) => {
    const aBuf = Buffer.from(a[0], 'utf8');
    const bBuf = Buffer.from(b[0], 'utf8');
    if (aBuf.length !== bBuf.length) return aBuf.length - bBuf.length;
    return aBuf.compare(bBuf);
  });
  writeHead(out, 5, entries.length); // major type 5 = map, definite length
  for (const [k, v] of entries) {
    encodeTextString(out, k);
    encodeTextString(out, v);
  }
}

/**
 * Canonical CBOR encoder for the fixed LaunchSpec shape:
 * `{ schemaVersion: 1, executable, argv, cwd, env, allowedExecutables }`.
 *
 * Map keys are sorted bytewise per RFC 8949 §4.2.1. All arrays and maps use
 * definite-length encoding. Integers use minimal-length forms.
 */
export function encodeCanonicalLaunchSpec(spec: VmWorkloadSpec): Buffer {
  const out: number[] = [];

  // Build the map with all 6 fields, keys sorted bytewise.
  // Fields: allowedExecutables, argv, cwd, env, executable, schemaVersion
  // (this is already the bytewise sort order for ASCII)
  const fields: Array<[string, () => void]> = [
    ['allowedExecutables', () => encodeStringMap(out, spec.allowedExecutables)],
    ['argv', () => encodeTextStringArray(out, spec.argv)],
    ['cwd', () => encodeTextString(out, spec.cwd)],
    ['env', () => encodeTextStringArray(out, spec.env)],
    ['executable', () => encodeTextString(out, spec.executable)],
    ['schemaVersion', () => encodeUint(out, 1)],
  ];

  // Sort by encoded key bytes (length first, then bytewise) per RFC 8949 §4.2.1
  fields.sort((a, b) => {
    const aBuf = Buffer.from(a[0], 'utf8');
    const bBuf = Buffer.from(b[0], 'utf8');
    if (aBuf.length !== bBuf.length) return aBuf.length - bBuf.length;
    return aBuf.compare(bBuf);
  });

  writeHead(out, 5, fields.length); // map, definite length
  for (const [key, encode] of fields) {
    encodeTextString(out, key);
    encode();
  }

  return Buffer.from(out);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function validateWorkloadSpec(spec: VmWorkloadSpec): void {
  if (hasNul(spec.executable)) throw new RunSpecError('executable contains NUL');
  if (hasNul(spec.cwd)) throw new RunSpecError('cwd contains NUL');
  for (const a of spec.argv) {
    if (hasNul(a)) throw new RunSpecError('argv entry contains NUL');
  }
  for (const e of spec.env) {
    if (!ENV_RE.test(e)) throw new RunSpecError(`env entry malformed: ${JSON.stringify(e)}`);
  }
  for (const [name, p] of Object.entries(spec.allowedExecutables)) {
    if (hasNul(name) || hasNul(p)) throw new RunSpecError('allowedExecutables entry contains NUL');
    if (!ABSOLUTE_RE.test(p)) throw new RunSpecError(`allowedExecutables value not absolute: ${p}`);
  }
}

export function encodeLaunchSpec(spec: VmWorkloadSpec): { blob: string; cborBytes: number } {
  validateWorkloadSpec(spec);
  const cborBuf = encodeCanonicalLaunchSpec(spec);
  if (cborBuf.byteLength > MAX_LAUNCH_SPEC_DECODED_BYTES) {
    throw new LaunchSpecTooLargeError('decoded', cborBuf.byteLength);
  }
  const blob = cborBuf.toString('base64url');
  if (blob.length > MAX_LAUNCH_SPEC_ARGV_BYTES) {
    throw new LaunchSpecTooLargeError('argv', blob.length);
  }
  return { blob, cborBytes: cborBuf.byteLength };
}
