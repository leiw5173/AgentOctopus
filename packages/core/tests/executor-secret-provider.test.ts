/**
 * Canary secret-isolation test (Plan 5 Task 7).
 *
 * A CANARY credential value is seeded into a SecretProvider. Every LLM-guided
 * execution path is driven through the REAL SandboxRunner with a recording
 * backend + proxy launcher + secret provider. The canary is then asserted to
 * appear ONLY in the proxy provisioning step (`proxy.launch` secrets detail —
 * the trusted egress path) and NOWHERE else:
 *   - not in any prompt passed to chatClient.chat
 *   - not in any ExecSpec.env captured by the backend
 *   - not in logs / event details other than proxy.launch secrets
 *   - not in error messages
 *   - not in global process.env
 *
 * Uses DI seams only (recording chatClient / backend / provider) — never a
 * child_process mock.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LoadedSkill, SkillRegistry } from '@agentoctopus/registry';
import { buildSnapshot, type ResolvedSecrets } from '@agentoctopus/sandbox';
import { Executor } from '../src/executor.js';
import { SandboxRunner } from '../src/sandbox-runner.js';
import {
  makeEventLog,
  RecordingBackend,
  RecordingProxyLauncher,
  RecordingSecretProvider,
  makeTrustedConfig,
  makeSnapshotStore,
  makeSkillFixture,
} from './sandbox-runner.test.js';

vi.mock('../src/utils.js', () => ({
  isBinAvailable: vi.fn().mockReturnValue(true),
}));

const CANARY = 'CANARY-SECRET-0xdeadbeef-DO-NOT-LEAK';
const CANARY_KEY = 'CANARY_API_KEY';

let dirs: string[] = [];

function makeRegistry(instructions = ''): SkillRegistry {
  return {
    recordInvocation: vi.fn(),
    recordInvocationMetrics: vi.fn(),
    readInstructions: vi.fn().mockReturnValue(instructions),
  } as unknown as SkillRegistry;
}

/** Recording chat client that captures every (system, user) prompt. */
function makeRecordingChatClient(reply: string) {
  const prompts: Array<{ system: string; user: string }> = [];
  return {
    prompts,
    chat: vi.fn(async (system: string, user: string) => {
      prompts.push({ system, user });
      return reply;
    }),
  };
}

interface Rig {
  runner: SandboxRunner;
  backend: RecordingBackend;
  provider: RecordingSecretProvider;
  proxy: RecordingProxyLauncher;
  record: (n: string, d?: unknown) => void;
  log: ReturnType<typeof makeEventLog>['log'];
}

/**
 * Build a rig whose trusted grant MATCHES the skill's real (content-derived)
 * digest, so provisionSecrets actually resolves the canary. The digest is
 * pre-computed with buildSnapshot against the same store dir the runner uses.
 */
async function makeRig(skill: LoadedSkill): Promise<Rig> {
  const { log, record } = makeEventLog();
  const backend = new RecordingBackend('docker', 'full', record);
  const provider = new RecordingSecretProvider();
  // Seed the canary keyed the way MapSecretProvider resolves it.
  provider.values.set(`inst-1:${CANARY_KEY}`, CANARY);
  provider.values.set(CANARY_KEY, CANARY);
  const proxy = new RecordingProxyLauncher(record);
  const snapshotStoreDir = makeSnapshotStore();

  // Compute the digest the runner WILL compute, so the trusted grant matches.
  const { identity } = await buildSnapshot({
    sourceDir: skill.dirPath,
    storeDir: snapshotStoreDir,
    installationId: 'inst-1',
    name: skill.manifest.name,
  });

  const runner = new SandboxRunner({
    config: makeTrustedConfig({
      grants: [
        {
          installationId: 'inst-1',
          digest: identity.digest,
          credentials: [
            {
              key: CANARY_KEY,
              host: 'api.example.com',
              port: 443,
              scheme: 'https',
              methods: ['GET'],
              pathPrefix: '/',
              header: 'Authorization',
            },
          ],
        },
      ],
    }),
    snapshotStoreDir,
    backends: [backend],
    proxyLauncher: proxy,
    secretProvider: provider,
    installationIdFor: () => 'inst-1',
    onEvent: record,
  });
  return { runner, backend, provider, proxy, record, log };
}

/** Serialize every captured artifact into one big string and scan for the canary. */
function collectNonProxyText(rig: Rig, chatPrompts: Array<{ system: string; user: string }>): string {
  const parts: string[] = [];
  // 1. every LLM prompt
  for (const p of chatPrompts) {
    parts.push('PROMPT_SYSTEM: ' + p.system);
    parts.push('PROMPT_USER: ' + p.user);
  }
  // 2. every ExecSpec.env captured by the backend
  const specEnv = rig.backend.lastRunSpec?.env ?? rig.backend.lastSpawnSpec?.env ?? {};
  parts.push('EXEC_ENV: ' + JSON.stringify(specEnv));
  parts.push('EXEC_CMD: ' + JSON.stringify(rig.backend.lastRunSpec?.command ?? rig.backend.lastSpawnSpec?.command ?? []));
  // 3. all event details EXCEPT the trusted proxy.launch secrets payload
  for (const e of rig.log) {
    if (e.name === 'proxy.launch') continue; // trusted egress — checked separately
    parts.push(`EVENT ${e.name}: ` + JSON.stringify(e.detail ?? null));
  }
  return parts.join('\n');
}

/** Extract only the secrets payload handed to the trusted proxy launcher. */
function proxySecretsText(rig: Rig): string {
  const launch = rig.log.find((e) => e.name === 'proxy.launch');
  if (!launch) return '';
  const detail = launch.detail as { secrets?: ResolvedSecrets } | undefined;
  return JSON.stringify(detail?.secrets ?? {});
}

afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  dirs = [];
  delete (process.env as Record<string, unknown>)[CANARY_KEY];
});

describe('canary secret isolation (LLM-guided paths)', () => {
  it('subprocess LLM-guided path: canary reaches ONLY proxy provisioning', async () => {
    const { dir, skill } = makeSkillFixture({
      instructions: 'run python3 scripts/run.py',
      sandboxBlock: { credentials: [CANARY_KEY] },
    });
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts', 'run.py'), '# noop');

    const rig = await makeRig(skill);
    rig.backend.runResult = {
      exitCode: 0,
      stdout: 'subprocess-ok',
      stderr: '',
      timedOut: false,
      meta: { isolationLevel: 'full', backend: 'docker', degraded: false, degradationReasons: [] },
    };

    const chat = makeRecordingChatClient('python3 scripts/run.py --fast');
    const executor = new Executor(makeRegistry('run python3 scripts/run.py'), chat as never, undefined, rig.runner);

    const result = await executor.execute(skill, { query: 'go' });
    expect('formattedOutput' in result && result.formattedOutput).toContain('subprocess-ok');

    // Canary MUST reach the trusted egress proxy.
    expect(proxySecretsText(rig)).toContain(CANARY);
    // Canary MUST NOT appear anywhere else.
    expect(collectNonProxyText(rig, chat.prompts)).not.toContain(CANARY);
    expect(process.env[CANARY_KEY]).toBeUndefined();
  });

  it('HTTP LLM-guided path: canary reaches ONLY proxy provisioning', async () => {
    const { dir, skill } = makeSkillFixture({
      name: 'http-llm',
      instructions: 'GET https://api.example.com/weather?q=<city>',
      sandboxBlock: { credentials: [CANARY_KEY] },
    });
    dirs.push(dir);
    (skill.manifest as { adapter: string }).adapter = 'http';

    const rig = await makeRig(skill);
    rig.backend.runResult = {
      exitCode: 0,
      stdout: '{"temp":72}',
      stderr: '',
      timedOut: false,
      meta: { isolationLevel: 'full', backend: 'docker', degraded: false, degradationReasons: [] },
    };

    const chat = makeRecordingChatClient('curl -s https://api.example.com/weather?q=tokyo');
    const executor = new Executor(
      makeRegistry('GET https://api.example.com/weather?q=<city>'),
      chat as never,
      undefined,
      rig.runner,
    );

    const result = await executor.execute(skill, { query: 'tokyo weather' });
    expect('formattedOutput' in result && result.formattedOutput).toContain('temp');

    expect(proxySecretsText(rig)).toContain(CANARY);
    expect(collectNonProxyText(rig, chat.prompts)).not.toContain(CANARY);
    expect(process.env[CANARY_KEY]).toBeUndefined();
  });

  it('canary present in process.env is still never interpolated into a prompt or env spec', async () => {
    // Even when the host process.env happens to carry the value, the executor
    // must never format it into a prompt or copy it into the guest env.
    process.env[CANARY_KEY] = CANARY;

    const { dir, skill } = makeSkillFixture({
      name: 'http-llm',
      instructions: 'GET https://api.example.com/weather?q=<city>',
      sandboxBlock: { credentials: [CANARY_KEY] },
    });
    dirs.push(dir);
    (skill.manifest as { adapter: string }).adapter = 'http';

    const rig = await makeRig(skill);
    rig.backend.runResult = {
      exitCode: 0,
      stdout: '{"temp":72}',
      stderr: '',
      timedOut: false,
      meta: { isolationLevel: 'full', backend: 'docker', degraded: false, degradationReasons: [] },
    };

    const chat = makeRecordingChatClient('curl -s https://api.example.com/weather?q=tokyo');
    const executor = new Executor(
      makeRegistry('GET https://api.example.com/weather?q=<city>'),
      chat as never,
      undefined,
      rig.runner,
    );

    await executor.execute(skill, { query: 'tokyo weather' });

    // The guest ExecSpec.env must NOT carry the canary (env hygiene is allowlist).
    expect(collectNonProxyText(rig, chat.prompts)).not.toContain(CANARY);
  });

  it('error results never echo the canary', async () => {
    const { dir, skill } = makeSkillFixture({
      instructions: 'run python3 scripts/run.py',
      sandboxBlock: { credentials: [CANARY_KEY] },
    });
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts', 'run.py'), '# noop');

    const rig = await makeRig(skill);
    rig.backend.runResult = {
      exitCode: 1,
      stdout: '',
      stderr: 'boom',
      timedOut: false,
      meta: { isolationLevel: 'full', backend: 'docker', degraded: false, degradationReasons: [] },
    };

    const chat = makeRecordingChatClient('python3 scripts/run.py');
    const executor = new Executor(makeRegistry('run python3 scripts/run.py'), chat as never, undefined, rig.runner);

    const result = await executor.execute(skill, { query: 'go' });
    const errText = 'adapterResult' in result ? (result.adapterResult.error ?? '') : '';
    expect(errText).not.toContain(CANARY);
    expect(collectNonProxyText(rig, chat.prompts)).not.toContain(CANARY);
  });
});
