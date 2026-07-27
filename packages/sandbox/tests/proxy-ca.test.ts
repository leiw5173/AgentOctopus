import { describe, it, expect } from 'vitest';
import forge from 'node-forge';
import { SessionCa } from '../src/proxy/ca.js';

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
