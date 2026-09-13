// packages/sandbox/tests/windows/wrappers.test.ts
//
// Cross-platform fail-closed contract for the Windows TS wrappers
// (job / sid / acl / gate-client). Each wrapper spawns the helper exe or
// connects the gate-service named pipe; when the backend piece is absent the
// wrapper must REJECT with a typed WindowsSandboxError — never resolve.
//
// These tests run on every host: they point each wrapper at a bogus exe /
// pipe path and assert rejection. On a real Windows host with the helper
// built and the service running, the wrappers' happy paths are exercised by
// the sibling helper-*/gate-svc tests.
import { describe, it, expect } from 'vitest';
import { WindowsSandboxError } from '../../src/windows/errors.js';
import { deriveLoopbackSid } from '../../src/windows/sid.js';
import { grantRead } from '../../src/windows/acl.js';
import { launchSandboxed, normalizeProxyUrl } from '../../src/windows/job.js';
import { installGate, removeGate } from '../../src/windows/gate-client.js';

const BOGUS_EXE = 'C:\\no\\such\\octopus-sandbox-helper.exe';
const BOGUS_PIPE =
  process.platform === 'win32'
    ? '\\\\.\\pipe\\octopus-sandbox-gate-does-not-exist'
    : '/tmp/octopus-sandbox-gate-does-not-exist.sock';

describe('windows wrappers fail closed when backend pieces missing', () => {
  it('deriveLoopbackSid rejects without helper exe', async () => {
    await expect(deriveLoopbackSid('AgentOctopus.Sandbox.x', { exePath: BOGUS_EXE })).rejects.toThrow(
      WindowsSandboxError,
    );
  });

  it('grantRead rejects without helper exe', async () => {
    await expect(
      grantRead('AgentOctopus.Sandbox.x', 'C:\\no\\such\\dir', { exePath: BOGUS_EXE }),
    ).rejects.toThrow(WindowsSandboxError);
  });

  it('launchSandboxed rejects without helper exe', async () => {
    await expect(
      launchSandboxed(
        {
          jobName: 'J',
          memMb: 128,
          pkgMoniker: 'AgentOctopus.Sandbox.x',
          restrictedToken: true,
          proxy: '127.0.0.1:8080',
          caPath: 'C:\\no\\ca.pem',
          bootstrapPath: 'C:\\no\\bootstrap.cjs',
          nodePath: 'C:\\no\\node.exe',
          argv: ['main.js'],
        },
        { exePath: BOGUS_EXE },
      ),
    ).rejects.toThrow(WindowsSandboxError);
  });

  it('installGate rejects without service pipe', async () => {
    await expect(
      installGate(
        {
          sessionId: 'x',
          appIdPath: 'C:\\no\\node.exe',
          proxyHost: '127.0.0.1',
          proxyPort: 1,
          jobName: 'J',
          proxyV6Loopback: false,
        },
        { pipePath: BOGUS_PIPE, timeoutMs: 2000 },
      ),
    ).rejects.toThrow(WindowsSandboxError);
  });

  it('installGate rejects an empty appIdPath before any transport', async () => {
    await expect(
      installGate(
        {
          sessionId: 'x',
          appIdPath: '',
          proxyHost: '127.0.0.1',
          proxyPort: 1,
          jobName: 'J',
          proxyV6Loopback: false,
        },
        { pipePath: BOGUS_PIPE, timeoutMs: 2000 },
      ),
    ).rejects.toThrow(WindowsSandboxError);
  });

  it('removeGate rejects without service pipe', async () => {
    await expect(removeGate('x', { pipePath: BOGUS_PIPE, timeoutMs: 2000 })).rejects.toThrow(
      WindowsSandboxError,
    );
  });
});

describe('job proxy scheme normalization (spec §4d)', () => {
  it('prepends http:// to a bare host:port', () => {
    expect(normalizeProxyUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });

  it('accepts {host, port} and prepends http://', () => {
    expect(normalizeProxyUrl({ host: '127.0.0.1', port: 8080 })).toBe('http://127.0.0.1:8080');
  });

  it('leaves an already scheme-qualified URL untouched', () => {
    expect(normalizeProxyUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });
});
