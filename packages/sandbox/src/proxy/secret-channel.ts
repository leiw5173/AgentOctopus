import crypto from 'node:crypto';
import type { ResolvedSecrets } from './egress-proxy.js';
import type { SessionCa } from './ca.js';

const MAX_FRAME_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_TIMEOUT_MS = 10_000;

export interface SecretEnvelope {
  nonce: string;
  secrets: ResolvedSecrets;
  sessionCa: { certPem: string; privateKeyPem: string };
}

export interface OneShotSecretWriter {
  readonly nonce: string;
  writeTo(stream: NodeJS.WritableStream): Promise<void>;
  close(): Promise<void>;
}

export function createOneShotSecretWriter(input: {
  secrets: ResolvedSecrets;
  ca: SessionCa;
}): OneShotSecretWriter {
  const nonce = crypto.randomBytes(32).toString('hex'); // 256-bit nonce
  let written = false;
  let closed = false;
  let retainedSecrets: ResolvedSecrets | null = { ...input.secrets };

  const zeroSecrets = () => {
    if (retainedSecrets) {
      for (const k of Object.keys(retainedSecrets)) {
        retainedSecrets[k] = '';
      }
      retainedSecrets = null;
    }
  };

  return {
    nonce,

    async writeTo(stream: NodeJS.WritableStream): Promise<void> {
      if (written) throw new Error('one-shot secret writer: second call rejected');
      if (closed) throw new Error('one-shot secret writer: already closed');
      written = true;

      const envelope: SecretEnvelope = {
        nonce,
        secrets: retainedSecrets!,
        sessionCa: input.ca.toEnvelope(),
      };
      const json = JSON.stringify(envelope);
      const payload = Buffer.from(json, 'utf8');
      const frame = Buffer.alloc(4 + payload.length);
      frame.writeUInt32BE(payload.length, 0);
      payload.copy(frame, 4);

      // Zero intermediate buffers after copying into frame
      payload.fill(0);

      await new Promise<void>((resolve, reject) => {
        stream.write(frame, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Zero the frame buffer and retained secrets
      frame.fill(0);
      zeroSecrets();

      // Close the stream after exactly one frame
      stream.end();
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      zeroSecrets();
    },
  };
}

export function readOneShotSecrets(
  stream: NodeJS.ReadableStream,
  expectedNonce: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ secrets: ResolvedSecrets; sessionCa: { certPem: string; privateKeyPem: string } }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('one-shot secret reader: timeout waiting for frame'));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      // Close/destroy the fd if possible
      if ('destroy' in stream && typeof stream.destroy === 'function') {
        stream.destroy();
      }
    };

    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      // Zero all accumulated chunks
      for (const c of chunks) c.fill(0);
      cleanup();
      reject(new Error(`one-shot secret reader: ${msg}`));
    };

    const succeed = (secrets: ResolvedSecrets, sessionCa: { certPem: string; privateKeyPem: string }) => {
      if (settled) return;
      settled = true;
      // Zero all accumulated chunks
      for (const c of chunks) c.fill(0);
      cleanup();
      resolve({ secrets, sessionCa });
    };

    const onError = (err: Error) => fail(`stream error: ${err.message}`);
    const onEnd = () => {
      if (totalBytes < 4) fail('unexpected EOF before frame header');
      // If we have data but haven't processed it yet, 'data' handler should have handled it.
      // If we reach here with exactly 4+ bytes but no parse, it's still an error.
      if (!settled) fail('unexpected EOF before complete frame');
    };

    const onData = (chunk: Buffer) => {
      if (settled) return;
      chunks.push(Buffer.from(chunk));
      totalBytes += chunk.length;

      if (totalBytes > MAX_FRAME_BYTES) {
        fail(`frame exceeds maximum size (${MAX_FRAME_BYTES} bytes)`);
        return;
      }

      if (totalBytes < 4) return; // need header first

      // We may have the full frame already; try to parse.
      const buf = Buffer.concat(chunks);
      const declaredLen = buf.readUInt32BE(0);
      if (declaredLen > MAX_FRAME_BYTES) {
        fail(`frame size ${declaredLen} exceeds maximum bound (${MAX_FRAME_BYTES} bytes)`);
        return;
      }

      if (buf.length < 4 + declaredLen) return; // wait for more data

      // We have exactly one complete frame (or more). Reject trailing bytes.
      if (buf.length > 4 + declaredLen) {
        fail('trailing bytes after one-shot frame');
        return;
      }

      // Parse JSON
      let envelope: SecretEnvelope;
      try {
        const json = buf.subarray(4).toString('utf8');
        envelope = JSON.parse(json) as SecretEnvelope;
      } catch {
        fail('invalid JSON in frame');
        return;
      }

      // Verify nonce with timingSafeEqual
      const expectedBuf = Buffer.from(expectedNonce, 'utf8');
      const actualBuf = Buffer.from(envelope.nonce ?? '', 'utf8');
      if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
        fail('nonce mismatch');
        return;
      }

      if (!envelope.secrets || typeof envelope.secrets !== 'object') {
        fail('missing secrets in envelope');
        return;
      }
      if (!envelope.sessionCa || typeof envelope.sessionCa.certPem !== 'string' || typeof envelope.sessionCa.privateKeyPem !== 'string') {
        fail('missing session CA material in envelope');
        return;
      }

      succeed(envelope.secrets, envelope.sessionCa);
    };

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}
