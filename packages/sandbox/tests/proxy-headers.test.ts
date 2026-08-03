import { describe, it, expect } from 'vitest';
import {
  sanitizeRequestHeaders,
  sanitizeResponseHeaders,
  injectCredential,
  SmugglingError,
} from '../src/proxy/headers.js';

describe('sanitizeRequestHeaders', () => {
  it('strips hop-by-hop headers and normalizes output keys to lowercase', () => {
    const out = sanitizeRequestHeaders({
      host: 'wttr.in', connection: 'keep-alive', 'keep-alive': 'timeout=5',
      'proxy-authorization': 'x', 'content-type': 'application/json',
    }, ['Host', 'wttr.in', 'Connection', 'keep-alive', 'Content-Type', 'application/json']);
    expect(out).not.toHaveProperty('connection');
    expect(out).not.toHaveProperty('keep-alive');
    expect(out).toHaveProperty('content-type');
    expect(Object.keys(out).every(k => k === k.toLowerCase())).toBe(true);
  });

  it('rejects conflicting Content-Length and Transfer-Encoding', () => {
    expect(() => sanitizeRequestHeaders({
      host: 'x', 'content-length': '5', 'transfer-encoding': 'chunked',
    }, ['Host', 'x', 'Content-Length', '5', 'Transfer-Encoding', 'chunked'])).toThrow(SmugglingError);
  });

  it('rejects duplicate Host fields from rawHeaders even if req.headers was collapsed', () => {
    expect(() => sanitizeRequestHeaders(
      { host: 'a.com' },
      ['Host', 'a.com', 'host', 'b.com'],
    )).toThrow(/duplicate Host/);
  });
});

describe('sanitizeResponseHeaders', () => {
  it('replaces upstream framing with the exact buffered body length', () => {
    const out = sanitizeResponseHeaders({
      'content-length': '999', 'transfer-encoding': 'chunked', connection: 'close',
      'content-type': 'text/plain',
    }, 4);
    expect(out).toEqual({ 'content-type': 'text/plain', 'content-length': '4' });
  });
});

describe('injectCredential', () => {
  const grant = { key: 'K', host: 'h', port: 443, scheme: 'https' as const, methods: ['GET'], pathPrefix: '/', header: 'Authorization', prefix: 'Bearer ' };

  it('overwrites an existing Authorization header (never appends)', () => {
    const out = injectCredential({ authorization: 'Bearer attacker-controlled' }, grant, 'realsecret');
    expect(out.authorization).toBe('Bearer realsecret');
  });

  it('adds the header when absent', () => {
    const out = injectCredential({}, grant, 'realsecret');
    expect(out.authorization).toBe('Bearer realsecret');
  });
});
