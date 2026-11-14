import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';
import { createSecureContext } from 'node:tls';
import { SessionCa, writeCaBundle } from '../src/proxy/ca.js';

describe('SessionCa', () => {
  it('issues a host cert verifiable against the CA', () => {
    const ca = SessionCa.create();
    const leaf = ca.issueForHost('wttr.in');
    const caCert = forge.pki.certificateFromPem(ca.certPem);
    const leafCert = forge.pki.certificateFromPem(leaf.certPem);
    // Leaf issuer == CA subject, and CA verifies leaf signature.
    expect(leafCert.issuer.getField('CN').value).toBe(caCert.subject.getField('CN').value);
    expect(caCert.verify(leafCert)).toBe(true);
    ca.destroy();
  });

  it.each(['0001000000000000', '8000000000000000', '0000000000000000'])(
    'issues a TLS-compatible positive serial for random bytes %s', (hex) => {
      const ca = SessionCa.create();
      const random = vi.spyOn(forge.random, 'getBytesSync').mockReturnValueOnce(forge.util.hexToBytes(hex));
      try {
        const leaf = ca.issueForHost('127.0.0.1');
        expect(() => createSecureContext({ cert: leaf.certPem, key: leaf.keyPem })).not.toThrow();
        const cert = forge.pki.certificateFromPem(leaf.certPem);
        expect(BigInt(`0x${cert.serialNumber}`)).toBeGreaterThan(0n);
        expect(parseInt(cert.serialNumber.slice(0, 2), 16)).toBeLessThan(128);
      } finally {
        random.mockRestore();
        ca.destroy();
      }
    },
  );

  it('uses dNSName SAN type 2 for hostnames and iPAddress SAN type 7 for literals', () => {
    const ca = SessionCa.create();
    const dnsLeaf = forge.pki.certificateFromPem(ca.issueForHost('api.example.com').certPem);
    const ipLeaf = forge.pki.certificateFromPem(ca.issueForHost('127.0.0.1').certPem);
    const dnsSan = dnsLeaf.getExtension('subjectAltName') as { altNames: Array<{ type: number; value: string; ip?: string }> };
    const ipSan = ipLeaf.getExtension('subjectAltName') as { altNames: Array<{ type: number; value: string; ip?: string }> };
    expect(dnsSan.altNames).toContainEqual(expect.objectContaining({ type: 2, value: 'api.example.com' }));
    expect(ipSan.altNames).toContainEqual(expect.objectContaining({ type: 7, ip: '127.0.0.1' }));
    ca.destroy();
  });
});

describe('writeCaBundle', () => {
  it('writes ca.pem exclusively into a 0700 dir and refuses overwrite', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ca-'));
    await writeCaBundle(dir, SessionCa.create());
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'ca.pem'))).mode & 0o777).toBe(0o444);
    await expect(writeCaBundle(dir, SessionCa.create())).rejects.toThrow(/EEXIST/);
  });

  it('opts.exclusive === false permits overwrite (non-default escape hatch)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ca-'));
    const first = SessionCa.create();
    await writeCaBundle(dir, first, { exclusive: false });
    const second = SessionCa.create();
    await writeCaBundle(dir, second, { exclusive: false });
    expect((await stat(join(dir, 'ca.pem'))).mode & 0o777).toBe(0o444);
  });
});
