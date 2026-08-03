#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SHA_RE = /^[0-9a-f]{40}$/;
const IMMUTABLE_DIGEST_RE = /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@)?sha256:[0-9a-f]{64}$/;

function fail(message) {
  throw new Error(`publish-gate: ${message}`);
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`missing ${label}`);
  return value;
}

function canonicalRunId(value, label) {
  const text = String(value ?? '');
  if (!/^[1-9][0-9]*$/.test(text)) fail(`${label} must be a positive integer`);
  return text;
}

function singleLine(value, label) {
  const text = nonEmptyString(value, label);
  if (/[\r\n]/.test(text)) fail(`${label} must be a single line`);
  return text;
}

export function validatePublishGate(input) {
  if (!input || typeof input !== 'object') fail('input must be an object');

  const metadata = input.metadata;
  const run = input.run;
  const jobsResponse = input.jobs;
  if (!metadata || typeof metadata !== 'object') fail('missing security metadata');
  if (!run || typeof run !== 'object') fail('missing preflight run metadata');
  if (!jobsResponse || typeof jobsResponse !== 'object') fail('missing preflight jobs metadata');

  if (metadata.schemaVersion !== 1) fail('security metadata schemaVersion must be 1');
  if (metadata.securityGateConclusion !== 'success') {
    fail(`recorded security gate result is not success (${String(metadata.securityGateConclusion)})`);
  }

  const expectedRunId = canonicalRunId(input.expectedRunId, 'expected run ID');
  const recordedRunId = canonicalRunId(metadata.preflightRunId, 'recorded preflight run ID');
  const apiRunId = canonicalRunId(run.id, 'API preflight run ID');
  if (expectedRunId !== recordedRunId || expectedRunId !== apiRunId) {
    fail(`preflight run ID mismatch (expected ${expectedRunId}, recorded ${recordedRunId}, API ${apiRunId})`);
  }
  const recordedAttempt = canonicalRunId(metadata.preflightRunAttempt, 'recorded preflight run attempt');
  const apiAttempt = canonicalRunId(run.run_attempt, 'API preflight run attempt');
  if (recordedAttempt !== apiAttempt) {
    fail(`preflight run attempt mismatch (recorded ${recordedAttempt}, API ${apiAttempt})`);
  }

  // Immutable run identity: `path` is load-bearing (a second workflow file can
  // copy `name:`, but cannot copy its path); event/branch pin the genuine
  // release-preflight trigger (push to master); name is secondary.
  if (run.path !== '.github/workflows/release-preflight.yml') {
    fail(`run is not the release-preflight workflow (path=${String(run.path)})`);
  }
  if (run.event !== 'push') fail(`preflight run event must be push (${String(run.event)})`);
  if (run.head_branch !== 'master') fail(`preflight run branch must be master (${String(run.head_branch)})`);
  if (run.name !== 'Release Preflight') fail(`run ${apiRunId} is not Release Preflight`);
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    fail(`preflight run did not succeed (status=${String(run.status)}, conclusion=${String(run.conclusion)})`);
  }

  const securitySha = singleLine(metadata.securitySha, 'security SHA');
  const runSha = singleLine(run.head_sha, 'preflight head SHA');
  if (!SHA_RE.test(securitySha)) fail('security SHA must be 40 lowercase hex');
  if (!SHA_RE.test(runSha)) fail('preflight head SHA must be 40 lowercase hex');
  if (securitySha !== runSha) {
    fail(`preflight head SHA does not match recorded security SHA (${runSha} != ${securitySha})`);
  }

  for (const [label, value] of [
    ['runtime', metadata.runtimeDigest],
    ['proxy', metadata.proxyDigest],
  ]) {
    if (typeof value !== 'string' || !IMMUTABLE_DIGEST_RE.test(value)) {
      fail(`${label} digest is not canonical and immutable`);
    }
  }

  const securityJobName = singleLine(metadata.securityJobName, 'security job name');
  if (!Array.isArray(jobsResponse.jobs)) fail('preflight jobs response has no jobs array');
  const matchingJobs = jobsResponse.jobs.filter((job) => job && job.name === securityJobName);
  if (matchingJobs.length === 0) fail(`missing required security job ${securityJobName}`);
  if (matchingJobs.length !== 1) fail(`expected one security job ${securityJobName}, found ${matchingJobs.length}`);

  const securityJob = matchingJobs[0];
  if (securityJob.status !== 'completed' || securityJob.conclusion !== 'success') {
    fail(`security job did not succeed (status=${String(securityJob.status)}, conclusion=${String(securityJob.conclusion)})`);
  }
  if (typeof securityJob.head_sha !== 'string' || securityJob.head_sha !== securitySha) {
    fail(`security job head SHA missing or does not match recorded security SHA (${String(securityJob.head_sha)} != ${securitySha})`);
  }

  return {
    runId: expectedRunId,
    securitySha,
    securityJobName,
    runtimeDigest: metadata.runtimeDigest,
    proxyDigest: metadata.proxyDigest,
  };
}

async function main(argv) {
  const inputPath = argv[0];
  if (!inputPath || argv.length !== 1) fail('usage: node validate-publish-gate.mjs <validation-input.json>');
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const validated = validatePublishGate(input);
  console.log(`publish-gate: OK (run ${validated.runId}, sha ${validated.securitySha}, job ${validated.securityJobName})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
