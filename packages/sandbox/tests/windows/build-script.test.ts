// packages/sandbox/tests/windows/build-script.test.ts
import { describe, it, expect } from 'vitest';
import { sha256File } from '../../scripts/build-win-helper.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

describe('build-win-helper sha256File', () => {
  it('hashes a file as lowercase hex', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bwh-'));
    const f = path.join(dir, 'a.bin'); writeFileSync(f, 'hello');
    expect(await sha256File(f)).toBe(createHash('sha256').update('hello').digest('hex'));
  });
});
