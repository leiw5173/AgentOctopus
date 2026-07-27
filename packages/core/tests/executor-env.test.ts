/**
 * Credential / prompt / env hygiene — SOURCE guards (Plan 5 Task 7).
 *
 * These read the actual executor.ts source and reject any pattern that would
 * let a credential VALUE reach an LLM prompt, an ExecSpec.env, a log, an error,
 * or global process.env. They SUPPLEMENT the behavioral canary tests in
 * executor-secret-provider.test.ts; they do not replace them.
 *
 * The security invariant: credential VALUES may ONLY reach the trusted egress
 * proxy via SandboxRunner.provisionSecrets. Prompt context may carry credential
 * KEY NAMES plus a configured/not-configured boolean — never a value, never an
 * `= <anything>` interpolation.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const CORE_SRC = path.join(__dirname, '..', 'src');

function readSrc(file: string): string {
  return fs.readFileSync(path.join(CORE_SRC, file), 'utf-8');
}

describe('executor credential/env hygiene — source guards', () => {
  const executorSource = readSrc('executor.ts');

  it('has no credential-value interpolation into prompts (${val} / = ${val})', () => {
    // The defect: `  ${v.key} = ${val} (already set)`. Forbid any `= ${...}`
    // credential formatting and any `${val}` interpolation derived from a
    // credential read.
    expect(executorSource).not.toMatch(/= \$\{val\}/);
    expect(executorSource).not.toMatch(/\$\{v\.key\} = /);
    expect(executorSource).not.toMatch(/subCredLines|credLines/);
  });

  it('has no "Available credentials" block carrying values', () => {
    expect(executorSource).not.toMatch(/Available credentials/);
    expect(executorSource).not.toMatch(/subCredContext|credContext/);
    expect(executorSource).not.toMatch(/\(already set\)|\(available in env\)/);
  });

  it('has no broad commonKeyPattern environment scan', () => {
    expect(executorSource).not.toMatch(/commonKeyPattern/);
    // No iterating process.env entries to surface key=value into a prompt.
    expect(executorSource).not.toMatch(/Object\.entries\(process\.env\)/);
  });

  it('never reads a credential VALUE into a variable for prompt building', () => {
    // `const val = process.env[v.key];` was the leak source. Presence checks
    // (`!!process.env[key]` / `!effectiveEnv[v.key]`) are fine — only the value
    // binding into a local for formatting is forbidden.
    expect(executorSource).not.toMatch(/const val = process\.env\[/);
  });

  it('has NO process.env writes anywhere', () => {
    expect(executorSource).not.toMatch(/process\.env\[[^\]]+\]\s*=[^=]/);
    expect(executorSource).not.toMatch(/process\.env\.\w+\s*=[^=]/);
    expect(executorSource).not.toMatch(/delete process\.env/);
  });

  it('has no applySkillEnvOverrides execution-time env mutation', () => {
    expect(executorSource).not.toMatch(/applySkillEnvOverrides/);
  });
});

describe('secret-provider module — source guards', () => {
  it('secret-provider.ts builds a MapSecretProvider without logging values', () => {
    const sp = readSrc('secret-provider.ts');
    expect(sp).toMatch(/MapSecretProvider/);
    // Must not log/console the secret material it seeds.
    expect(sp).not.toMatch(/console\.(log|info|warn|error|debug)/);
    // Must not interpolate a value into a string template destined for output.
    expect(sp).not.toMatch(/= \$\{/);
  });
});
