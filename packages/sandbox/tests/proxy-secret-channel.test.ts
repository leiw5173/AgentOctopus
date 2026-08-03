import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { createOneShotSecretWriter, readOneShotSecrets } from '../src/proxy/secret-channel.js';
import { SessionCa } from '../src/proxy/ca.js';
import type { ResolvedSecrets } from '../src/proxy/egress-proxy.js';

function makeSecrets(): ResolvedSecrets {
  return { api_key: 'sk-test-abc123', db_password: 'p@ssw0rd' };
}

describe('one-shot secret pipe', () => {
  it('delivers the exact grant-scoped map from one length-prefixed frame', async () => {
    const ca = SessionCa.create();
    const writer = createOneShotSecretWriter({ secrets: makeSecrets(), ca });
    const stream = new PassThrough();
    const writePromise = writer.writeTo(stream);
    const result = await readOneShotSecrets(stream, writer.nonce);
    await writePromise;

    expect(result.secrets).toEqual(makeSecrets());
    expect(result.sessionCa.certPem).toBe(ca.certPem);
    expect(result.sessionCa.privateKeyPem).toBeDefined();
    ca.destroy();
  });

  it('rejects a wrong nonce without returning secret bytes', async () => {
    const ca = SessionCa.create();
    const writer = createOneShotSecretWriter({ secrets: makeSecrets(), ca });
    const stream = new PassThrough();
    const writePromise = writer.writeTo(stream);
    await expect(readOneShotSecrets(stream, '0'.repeat(64))).rejects.toThrow(/nonce/i);
    await writePromise;
    ca.destroy();
  });

  it('rejects a second writer call, trailing frames, oversized frames, and timeout', async () => {
    const ca = SessionCa.create();

    // Second writer call rejected
    const writer = createOneShotSecretWriter({ secrets: makeSecrets(), ca });
    const stream = new PassThrough();
    await writer.writeTo(stream);
    await expect(writer.writeTo(stream)).rejects.toThrow(/second|already/i);

    // Trailing bytes rejected: write two frames manually
    const stream2 = new PassThrough();
    const writer2 = createOneShotSecretWriter({ secrets: makeSecrets(), ca });
    const frame1 = Buffer.alloc(4);
    const payload = JSON.stringify({
      nonce: writer2.nonce,
      secrets: makeSecrets(),
      sessionCa: { certPem: ca.certPem, privateKeyPem: ca.toEnvelope().privateKeyPem },
    });
    frame1.writeUInt32BE(Buffer.byteLength(payload), 0);
    stream2.write(Buffer.concat([frame1, Buffer.from(payload), Buffer.from('extra')]));
    stream2.end();
    await expect(readOneShotSecrets(stream2, writer2.nonce)).rejects.toThrow(/trailing|extra/i);

    // Oversized frame rejected
    const stream3 = new PassThrough();
    const bigPayload = Buffer.alloc(2 * 1024 * 1024, 0x41); // 2 MiB
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(bigPayload.length, 0);
    stream3.write(lenBuf);
    stream3.write(bigPayload);
    stream3.end();
    await expect(readOneShotSecrets(stream3, writer2.nonce)).rejects.toThrow(/size|large|bound/i);

    // Timeout rejected
    const stream4 = new PassThrough();
    // never write anything
    await expect(readOneShotSecrets(stream4, writer2.nonce, 50)).rejects.toThrow(/timeout|timed/i);

    ca.destroy();
  });

  it('closes both ends after one delivery', async () => {
    const ca = SessionCa.create();
    const writer = createOneShotSecretWriter({ secrets: makeSecrets(), ca });
    const stream = new PassThrough();
    const writePromise = writer.writeTo(stream);
    await readOneShotSecrets(stream, writer.nonce);
    await writePromise;

    // Stream should be ended/closed by writer
    expect(stream.writableEnded || stream.destroyed).toBe(true);
    ca.destroy();
  });
});
