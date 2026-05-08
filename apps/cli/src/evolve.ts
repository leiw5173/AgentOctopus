import { select, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs';
import { loadConfig, getConfig } from '@agentoctopus/core';
import {
  readProposal,
  applyChanges,
  clearProposal,
  listSnapshots,
  rollback,
  getSignalsSince,
} from '@agentoctopus/skills';

export async function runEvolveCheck(): Promise<void> {
  loadConfig();
  const config = getConfig();

  if (!config.evolution.enabled) {
    console.log(chalk.yellow('  Evolution is not enabled.'));
    console.log(chalk.gray('  Run `octopus onboard` to enable it, or set evolution.enabled: true in ~/.agentoctopus/octopus.json'));
    return;
  }

  const skillsDir = config.registry?.skillsDir || path.join(process.env.HOME || '~', '.agentoctopus', 'skills');

  if (!fs.existsSync(skillsDir)) {
    console.log(chalk.gray('  No skills directory found.'));
    return;
  }

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'));

  const issues: Array<{ name: string; status: string; detail: string }> = [];
  const healthy: string[] = [];

  for (const entry of entries) {
    const skillDirPath = path.join(skillsDir, entry.name);
    const evolutionDir = path.join(skillDirPath, '.evolution');

    // Check for pending proposal
    const proposal = readProposal(evolutionDir);
    if (proposal) {
      issues.push({ name: entry.name, status: 'proposal', detail: `proposal ready — ${proposal.evidence.slice(0, 80)}` });
      continue;
    }

    // Check for negative feedback
    const since = new Date(0).toISOString();
    const signals = getSignalsSince(evolutionDir, since);
    const negativeFeedback = signals.filter((s) => s.type === 'feedback' && s.positive === false);
    if (negativeFeedback.length >= config.evolution.feedbackThreshold) {
      issues.push({ name: entry.name, status: 'negative', detail: `${negativeFeedback.length} negative feedback entries` });
      continue;
    }

    // Check staleness (no signals at all)
    if (signals.length === 0) {
      issues.push({ name: entry.name, status: 'stale', detail: 'no invocations recorded' });
      continue;
    }

    healthy.push(entry.name);
  }

  console.log(chalk.bold('\n  Skill Evolution Status'));
  console.log(chalk.gray('  ──────────────────────────────────────────────────'));

  const statusIcon: Record<string, string> = {
    proposal: chalk.red('✗'),
    negative: chalk.red('✗'),
    stale: chalk.yellow('⟳'),
  };

  for (const issue of issues) {
    console.log(`  ${statusIcon[issue.status]} ${issue.name.padEnd(18)} ${chalk.gray(issue.detail)}`);
  }
  for (const name of healthy) {
    console.log(`  ${chalk.green('✓')} ${name.padEnd(18)} ${chalk.gray('healthy')}`);
  }

  console.log(chalk.gray('  ──────────────────────────────────────────────────'));

  if (issues.length > 0) {
    const withProposals = issues.filter((i) => i.status === 'proposal');
    if (withProposals.length > 0) {
      console.log(`\n  ${withProposals.length} skill(s) have pending proposals.`);
      console.log(`  Run ${chalk.cyan('octopus evolve --review')} to inspect.\n`);
    } else {
      console.log(`\n  ${issues.length} skill(s) need attention.`);
      console.log(`  Run ${chalk.cyan('octopus evolve --propose <skill>')} to generate proposals.\n`);
    }
  } else {
    console.log(`\n  All skills healthy.\n`);
  }
}

export async function runEvolveReview(): Promise<void> {
  loadConfig();
  const config = getConfig();
  const skillsDir = config.registry?.skillsDir || path.join(process.env.HOME || '~', '.agentoctopus', 'skills');

  if (!fs.existsSync(skillsDir)) {
    console.log(chalk.gray('\n  No skills directory found.\n'));
    return;
  }

  // Scan all skill directories for proposals
  const pendingProposals: Array<{ evolutionDir: string; skillDirPath: string; proposal: NonNullable<ReturnType<typeof readProposal>> }> = [];
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const skillDirPath = path.join(skillsDir, entry.name);
    const evolutionDir = path.join(skillDirPath, '.evolution');
    const proposal = readProposal(evolutionDir);
    if (proposal) {
      pendingProposals.push({ evolutionDir, skillDirPath, proposal });
    }
  }

  if (pendingProposals.length === 0) {
    console.log(chalk.gray('\n  No pending proposals.\n'));
    return;
  }

  console.log(chalk.bold(`\n  Pending proposals: ${pendingProposals.length}`));
  console.log(chalk.gray('  ──────────────────────────────────────────────────'));

  for (const { proposal } of pendingProposals) {
    console.log(`\n  ${chalk.bold(`skill: ${proposal.skillName}`)}`);
    console.log(`  ${chalk.gray(`evidence: ${proposal.evidence}`)}`);
    console.log('');

    for (const change of proposal.changes) {
      const label = change.risk === 'safe'
        ? chalk.green('[safe, auto-applied]')
        : chalk.yellow('[risky, awaiting approval]');
      console.log(`  ${label}`);
      console.log(`  ${chalk.gray(change.field)}: ${change.rationale.slice(0, 100)}`);

      if (change.risk === 'risky') {
        console.log(`    ${chalk.red('old:')} ${change.original.slice(0, 80)}`);
        console.log(`    ${chalk.green('new:')} ${change.proposed.slice(0, 80)}`);
      }
    }

    console.log(chalk.gray('  ──────────────────────────────────────────────────'));
  }

  const choices = [
    ...pendingProposals.map((p) => ({
      value: `approve:${p.proposal.skillName}`,
      name: `Approve: ${p.proposal.skillName}`,
    })),
    ...pendingProposals.map((p) => ({
      value: `reject:${p.proposal.skillName}`,
      name: `Reject: ${p.proposal.skillName}`,
    })),
    { value: 'skip', name: 'Skip — do nothing' },
  ];

  const answer = await select({ message: 'Action:', choices });

  if (answer === 'skip') {
    console.log(chalk.gray('\n  No changes made.\n'));
    return;
  }

  if (answer.startsWith('approve:')) {
    const skillName = answer.replace('approve:', '');
    const entry = pendingProposals.find((p) => p.proposal.skillName === skillName);
    if (entry) {
      const result = applyChanges({ ...entry.proposal, skillDirPath: entry.skillDirPath });
      clearProposal(entry.evolutionDir);
      console.log(chalk.green(`\n  ✓ Applied ${result.applied + result.staged} change(s) to ${skillName}\n`));
    }
  } else if (answer.startsWith('reject:')) {
    const skillName = answer.replace('reject:', '');
    const entry = pendingProposals.find((p) => p.proposal.skillName === skillName);
    if (entry) {
      clearProposal(entry.evolutionDir);
      console.log(chalk.yellow(`\n  ✗ Rejected proposal for ${skillName}\n`));
    }
  }
}

export async function runEvolvePropose(skillName: string): Promise<void> {
  console.log(chalk.yellow(`\n  Manual proposal generation for "${skillName}":`));
  console.log(chalk.gray('  Proposals are generated automatically when signal thresholds are exceeded.'));
  console.log(chalk.gray('  To trigger: ensure evolution is enabled and accumulate invocation signals.\n'));
}

export async function runEvolveLog(skillName: string): Promise<void> {
  loadConfig();
  const config = getConfig();
  const skillsDir = config.registry?.skillsDir || path.join(process.env.HOME || '~', '.agentoctopus', 'skills');
  const evolutionDir = path.join(skillsDir, skillName, '.evolution');

  if (!fs.existsSync(evolutionDir)) {
    console.log(chalk.gray(`\n  No evolution data for ${skillName}.\n`));
    return;
  }

  const snapshots = listSnapshots(evolutionDir);
  if (snapshots.length === 0) {
    console.log(chalk.gray(`\n  No snapshots for ${skillName}.\n`));
    return;
  }

  console.log(chalk.bold(`\n  Snapshot timeline: ${skillName}`));
  console.log(chalk.gray('  ──────────────────────────────────────────────────'));
  snapshots.forEach((name, i) => {
    const ts = name.replace('.md', '');
    const isLatest = i === snapshots.length - 1;
    console.log(`  ${chalk.gray(`[${i}]`)} ${ts} ${isLatest ? chalk.green('← latest') : ''}`);
  });
  console.log('');
}

export async function runEvolveRollback(skillName: string, toIndex?: number): Promise<void> {
  loadConfig();
  const config = getConfig();
  const skillsDir = config.registry?.skillsDir || path.join(process.env.HOME || '~', '.agentoctopus', 'skills');
  const skillFilePath = path.join(skillsDir, skillName, 'SKILL.md');
  const evolutionDir = path.join(skillsDir, skillName, '.evolution');

  if (!fs.existsSync(skillFilePath)) {
    console.log(chalk.red(`\n  Skill ${skillName} not found.\n`));
    return;
  }

  const snapshots = listSnapshots(evolutionDir);
  if (snapshots.length === 0) {
    console.log(chalk.yellow(`\n  No snapshots available for ${skillName}.\n`));
    return;
  }

  const idx = toIndex !== undefined ? toIndex : snapshots.length - 1;

  if (idx < 0 || idx >= snapshots.length) {
    console.log(chalk.red(`\n  Invalid snapshot index: ${idx}. Valid: 0–${snapshots.length - 1}\n`));
    return;
  }

  const confirmed = await confirm({
    message: `Roll back ${skillName} to snapshot [${idx}] ${snapshots[idx]!.replace('.md', '')}?`,
    default: false,
  });

  if (!confirmed) {
    console.log(chalk.gray('\n  Rollback cancelled.\n'));
    return;
  }

  rollback(skillFilePath, evolutionDir, idx);
  console.log(chalk.green(`\n  ✓ Rolled back ${skillName} to snapshot [${idx}]\n`));
}
