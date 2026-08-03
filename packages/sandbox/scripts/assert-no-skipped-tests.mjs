#!/usr/bin/env node
/**
 * assert-no-skipped-tests.mjs — release-lane gate that forbids silently
 * skipped/pending/failed tests in a vitest JSON report.
 *
 * Usage: node scripts/assert-no-skipped-tests.mjs <vitest-report.json>
 *
 * sandbox-security.yml runs the privileged-Linux lane with
 * `--reporter=json --outputFile=/tmp/linux-security.json` and then invokes this
 * script on that file. Security tests must NOT be silently skippable at
 * release, so any test whose result is skipped/pending/todo OR failed exits
 * non-zero and names the offending tests.
 *
 * No dependencies — plain Node.
 */
import fs from 'node:fs';

function die(msg, code = 1) {
  console.error(`assert-no-skipped-tests: ERROR: ${msg}`);
  process.exit(code);
}

const reportPath = process.argv[2];
if (!reportPath) die('usage: node assert-no-skipped-tests.mjs <vitest-report.json>');

let raw;
try {
  raw = fs.readFileSync(reportPath, 'utf8');
} catch (err) {
  die(`cannot read report ${reportPath}: ${err.message}`);
}

let report;
try {
  report = JSON.parse(raw);
} catch (err) {
  die(`report ${reportPath} is not valid JSON: ${err.message}`);
}

const BAD_STATES = new Set(['skipped', 'pending', 'todo', 'failed', 'timedout']);
const offenders = [];

// vitest JSON (v1 default reporter) shape: { testResults: [ { assertionResults:
// [ { title, status, ancestorTitles } ] } ] }. Walk defensively so a shape
// change fails closed (treated as an error) rather than silently passing.
const suites = Array.isArray(report.testResults) ? report.testResults : null;
if (!suites) {
  die(`report ${reportPath} has no testResults array — unrecognized vitest JSON shape`);
}

for (const suite of suites) {
  const file = suite.name ?? suite.file ?? '<unknown file>';
  const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
  for (const a of assertions) {
    const status = String(a.status ?? '').toLowerCase();
    if (BAD_STATES.has(status)) {
      const name = [...(a.ancestorTitles ?? []), a.title].filter(Boolean).join(' > ');
      offenders.push(`  [${status}] ${file} :: ${name}`);
    }
  }
}

if (offenders.length > 0) {
  die(
    `found ${offenders.length} skipped/pending/todo/failed test(s) — security tests must not be silently skippable:\n` +
      offenders.join('\n'),
  );
}

console.log(`assert-no-skipped-tests: OK (${reportPath} — no skipped/pending/todo/failed tests)`);
