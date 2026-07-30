import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(__dirname, '..');

describe('vm-helper fd-ceiling regression (ME-3)', () => {
  it('fd-ceiling.test.c compiles and passes against current vm-helper.c', () => {
    const testSrc = path.join(sourceRoot, 'tests', 'fd-ceiling.test.c');
    const bin = path.join(sourceRoot, 'dist', 'fd-ceiling.test');

    const compile = spawnSync(
      'cc',
      ['-std=gnu17', '-Wall', '-Werror', '-o', bin, testSrc],
      { cwd: sourceRoot, encoding: 'utf8' },
    );
    if (compile.status !== 0) {
      throw new Error(
        `fd-ceiling.test.c compile failed:\n${compile.stderr}\n${compile.stdout}`,
      );
    }

    const run = spawnSync(bin, [], { cwd: sourceRoot, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      'PASS: fallback loop bound is derived from RLIMIT_NOFILE via fd_ceiling()',
    );
  });
});
