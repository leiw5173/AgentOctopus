import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import forge from 'node-forge';

/**
 * Per-session MITM CA (spec §8/§10). The CA private key lives only in memory
 * for the duration of one execution and is destroyed at cleanup. Only the CA
 * cert (never the key) is mounted into the sandbox.
 */
export class SessionCa {
  private constructor(
    private readonly caCert: forge.pki.Certificate,
    private caKey: forge.pki.rsa.PrivateKey | null,
  ) {}

  static create(): SessionCa {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date(Date.now() + 24 * 3600 * 1000);
    const attrs = [{ name: 'commonName', value: 'AgentOctopus Session CA' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    return new SessionCa(cert, keys.privateKey);
  }

  get certPem(): string {
    return forge.pki.certificateToPem(this.caCert);
  }

  issueForHost(hostname: string): { certPem: string; keyPem: string } {
    if (!this.caKey) throw new Error('SessionCa destroyed');
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(8));
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date(Date.now() + 24 * 3600 * 1000);
    cert.setSubject([{ name: 'commonName', value: hostname }]);
    cert.setIssuer(this.caCert.subject.attributes);
    cert.setExtensions([
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: net.isIP(hostname)
          ? [{ type: 7, ip: hostname }] // type 7 = iPAddress; encode address bytes, not a DNS string
          : [{ type: 2, value: hostname }], // type 2 = dNSName
      },
    ]);
    cert.sign(this.caKey, forge.md.sha256.create());
    return {
      certPem: forge.pki.certificateToPem(cert),
      keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    };
  }

  /**
   * Serialize the CA cert + private key to PEM for the one-shot secret channel.
   * Throws if the CA is destroyed. The writer calls this exactly once.
   */
  toEnvelope(): { certPem: string; privateKeyPem: string } {
    if (!this.caKey) throw new Error('SessionCa destroyed');
    return {
      certPem: forge.pki.certificateToPem(this.caCert),
      privateKeyPem: forge.pki.privateKeyToPem(this.caKey),
    };
  }

  /**
   * Reconstruct the SAME CA from PEM material received over the one-shot
   * channel. The standalone server uses this (never `create()`) so it signs
   * leaves with the launcher's CA. Throws on parse failure.
   */
  static fromEnvelope(material: { certPem: string; privateKeyPem: string }): SessionCa {
    const caCert = forge.pki.certificateFromPem(material.certPem);
    const caKey = forge.pki.privateKeyFromPem(material.privateKeyPem);
    return new SessionCa(caCert, caKey);
  }

  /** Zero the CA private key material. Idempotent. */
  destroy(): void {
    this.caKey = null;
  }
}

/** Write ca.pem into dir; return the file path (mounted read-only into the sandbox). */
export async function writeCaBundle(dir: string, ca: SessionCa): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, 'ca.pem');
  await fs.writeFile(p, ca.certPem, { mode: 0o444 });
  return p;
}
