import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { validatePublishGate } from '../../scripts/validate-publish-gate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

async function fixture(name) {
  return JSON.parse(await readFile(path.join(FIXTURES, name), 'utf8'));
}

describe('publish gate validation fixtures', () => {
  it('accepts a successful exact-run security gate with immutable digests', async () => {
    const input = await fixture('publish-gate-success.json');
    expect(() => validatePublishGate(input)).not.toThrow();
  });

  it.each([
    ['publish-gate-missing-security-job.json', 'missing security job'],
    ['publish-gate-failed-security-job.json', 'failed security job'],
    ['publish-gate-sha-mismatch.json', 'SHA mismatch'],
    ['publish-gate-mutable-digest.json', 'mutable digest'],
    ['publish-gate-foreign-path.json', 'foreign workflow path'],
    ['publish-gate-foreign-event.json', 'foreign run event'],
    ['publish-gate-foreign-branch.json', 'foreign head branch'],
    ['publish-gate-run-id-mismatch.json', 'run ID mismatch'],
    ['publish-gate-attempt-mismatch.json', 'run attempt mismatch'],
    ['publish-gate-duplicate-jobs.json', 'duplicate security jobs'],
    ['publish-gate-schema-version.json', 'schema version bump'],
    ['publish-gate-uppercase-sha.json', 'uppercase SHA'],
    ['publish-gate-missing-job-sha.json', 'missing job head SHA'],
  ])('rejects %s (%s)', async (name) => {
    const input = await fixture(name);
    expect(() => validatePublishGate(input)).toThrow(input.expectedError);
  });
});
