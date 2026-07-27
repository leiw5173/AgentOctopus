import type { Adapter, AdapterInput, AdapterInvocationContext, AdapterResult } from './adapter.js';

/**
 * Trusted in-sandbox HTTP runner.
 *
 * HttpAdapter must NOT host-fetch — the skill's endpoint is an untrusted
 * network path. Instead the request {method, url, headers, body} is serialized
 * into OCTOPUS_INPUT and executed INSIDE the sandbox by this tiny runner, which
 * uses the runtime's global `fetch`. The egress proxy (always launched by the
 * SandboxRunner, including deny-all sessions) enforces host/method/path and
 * injects credentials via the HTTP(S)_PROXY / CA env the backend provisions.
 *
 * The adapter NEVER injects process.env API keys itself — credential injection
 * is the proxy's job (grants come from trusted config, not the skill).
 *
 * The runner reads the request from OCTOPUS_INPUT, performs the fetch, and
 * writes a single JSON envelope to stdout:
 *   { ok, status, body }
 * honoring HTTP(S)_PROXY / NODE_EXTRA_CA_CERTS already present in the guest env.
 */
const HTTP_RUNNER_SOURCE = `
'use strict';
(async () => {
  const raw = process.env.OCTOPUS_INPUT;
  if (!raw) {
    process.stdout.write(JSON.stringify({ ok: false, status: 0, body: 'OCTOPUS_INPUT missing' }));
    return;
  }
  let req;
  try {
    req = JSON.parse(raw);
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, status: 0, body: 'bad OCTOPUS_INPUT: ' + String(e) }));
    return;
  }
  try {
    const doFetch = globalThis.fetch;
    const res = await doFetch(req.url, {
      method: req.method || 'POST',
      headers: req.headers || {},
      body: req.body !== undefined ? req.body : undefined,
    });
    const body = await res.text();
    process.stdout.write(JSON.stringify({ ok: res.ok, status: res.status, body }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, status: 0, body: String((e && e.message) || e) }));
  }
})();
`;

interface HttpRunnerEnvelope {
  ok: boolean;
  status: number;
  body: string;
}

export class HttpAdapter implements Adapter {
  async invoke(input: AdapterInput, context: AdapterInvocationContext): Promise<AdapterResult> {
    const { skill } = input;
    const { endpoint } = skill.manifest;

    if (!endpoint) {
      return { success: false, error: 'Skill has no endpoint configured.' };
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'AgentOctopus/0.1.0',
    };
    // NOTE: no process.env API-key injection here. If the skill declares an
    // api_key credential, the egress proxy injects it per the trusted grant.

    const request = {
      method: 'POST',
      url: endpoint,
      headers,
      body: JSON.stringify(context.payload ?? input.input),
    };

    // `node` resolves via the trusted runtime profile's guest PATH. The runner
    // source is passed with -e; the request rides in OCTOPUS_INPUT.
    const result = await context.sandbox.run({
      command: ['node', '-e', HTTP_RUNNER_SOURCE],
      invocation: { payload: request },
      timeoutMs: context.timeoutMs,
    });

    if (!result.success) {
      return {
        success: false,
        error: result.error ?? result.stderr ?? 'HTTP request failed in sandbox',
        rawText: result.rawText,
      };
    }

    let envelope: HttpRunnerEnvelope;
    try {
      envelope = JSON.parse((result.rawText ?? '').trim()) as HttpRunnerEnvelope;
    } catch {
      return {
        success: false,
        error: `Malformed response from in-sandbox HTTP runner: ${(result.rawText ?? '').slice(0, 200)}`,
        rawText: result.rawText,
      };
    }

    if (!envelope.ok) {
      return {
        success: false,
        error: envelope.status > 0 ? `HTTP ${envelope.status}: ${envelope.body}` : envelope.body,
        rawText: envelope.body,
      };
    }

    let data: unknown;
    try {
      data = JSON.parse(envelope.body);
    } catch {
      data = envelope.body;
    }

    return { success: true, data, rawText: envelope.body };
  }
}
