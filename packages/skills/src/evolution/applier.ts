import fs from 'fs';
import path from 'path';
import type { EvolutionProposal } from './types.js';
import { shadowCopy } from './rollback.js';
import { recordSignal } from './collector.js';

interface ApplyResult {
  applied: number;
  staged: number;
}

export function applyChanges(proposal: EvolutionProposal): ApplyResult {
  const skillFilePath = path.join(proposal.skillDirPath, 'SKILL.md');
  const evolutionDir = path.join(proposal.skillDirPath, '.evolution');
  let applied = 0;
  let staged = 0;

  const safeChanges = proposal.changes.filter((c) => c.risk === 'safe');
  const riskyChanges = proposal.changes.filter((c) => c.risk === 'risky');

  if (safeChanges.length > 0) {
    // Save shadow copy before any mutation
    shadowCopy(skillFilePath, evolutionDir, 20);

    let content = fs.readFileSync(skillFilePath, 'utf8');
    for (const change of safeChanges) {
      if (content.includes(change.original)) {
        content = content.replace(change.original, change.proposed);
        applied++;
      }
    }
    fs.writeFileSync(skillFilePath, content, 'utf8');

    for (const change of safeChanges) {
      recordSignal(evolutionDir, {
        type: 'evolution',
        change: `${change.field}: ${change.original.slice(0, 80)} → ${change.proposed.slice(0, 80)}`,
        risk: 'safe',
      });
    }
  }

  if (riskyChanges.length > 0) {
    const riskyProposal: EvolutionProposal = { ...proposal, changes: riskyChanges };
    stageProposal(evolutionDir, riskyProposal);
    staged = riskyChanges.length;
  }

  return { applied, staged };
}

export function stageProposal(evolutionDir: string, proposal: EvolutionProposal): void {
  fs.mkdirSync(evolutionDir, { recursive: true });
  const proposalPath = path.join(evolutionDir, 'proposal.md');

  const lines = [
    `# Evolution Proposal: ${proposal.skillName}`,
    `**Generated:** ${proposal.generatedAt}`,
    `**Evidence:** ${proposal.evidence}`,
    '',
    '## Changes',
    '',
  ];

  for (const change of proposal.changes) {
    lines.push(`### ${change.field} (risk: ${change.risk})`);
    lines.push(`**Rationale:** ${change.rationale}`);
    lines.push('');
    lines.push('```diff');
    lines.push(`- ${change.original}`);
    lines.push(`+ ${change.proposed}`);
    lines.push('```');
    lines.push('');
  }

  fs.writeFileSync(proposalPath, lines.join('\n'), 'utf8');
}

export function readProposal(evolutionDir: string): EvolutionProposal | null {
  const proposalPath = path.join(evolutionDir, 'proposal.md');
  if (!fs.existsSync(proposalPath)) return null;

  const raw = fs.readFileSync(proposalPath, 'utf8');

  // Parse proposal.md back to structured data
  const skillMatch = raw.match(/^# Evolution Proposal: (.+)$/m);
  const dateMatch = raw.match(/^\*\*Generated:\*\* (.+)$/m);
  const evidenceMatch = raw.match(/^\*\*Evidence:\*\* (.+)$/m);

  if (!skillMatch || !dateMatch) return null;

  const changes: EvolutionProposal['changes'] = [];
  const changeBlocks = raw.split(/^### /m).slice(1);

  for (const block of changeBlocks) {
    const headerMatch = block.match(/^(.+?) \(risk: (safe|risky)\)\n/);
    const rationaleMatch = block.match(/\*\*Rationale:\*\* (.+)/);
    const diffMatch = block.match(/- (.+)\n\+ (.+)/);

    if (headerMatch && diffMatch) {
      changes.push({
        field: headerMatch[1] as EvolutionProposal['changes'][number]['field'],
        risk: headerMatch[2] as 'safe' | 'risky',
        original: diffMatch[1],
        proposed: diffMatch[2],
        rationale: rationaleMatch ? rationaleMatch[1] : '',
      });
    }
  }

  return {
    skillName: skillMatch[1],
    skillDirPath: '',
    generatedAt: dateMatch[1],
    evidence: evidenceMatch ? evidenceMatch[1] : '',
    changes,
  };
}

export function clearProposal(evolutionDir: string): void {
  const proposalPath = path.join(evolutionDir, 'proposal.md');
  if (fs.existsSync(proposalPath)) {
    fs.unlinkSync(proposalPath);
  }
}
