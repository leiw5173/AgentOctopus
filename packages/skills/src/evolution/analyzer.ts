import type { EvolutionSignal, EvolutionProposal, EvolutionChange } from './types.js';

export function buildAnalysisPrompt(
  skillName: string,
  evidenceSummary: string,
  skillMdContent: string,
  signals: EvolutionSignal[],
): string {
  const signalSummary = signals
    .map((s) => {
      if (s.type === 'invocation') {
        return `- invocation: success=${s.success}, latency=${s.latencyMs}ms, tokens=${s.tokenUsage}${s.error ? `, error="${s.error}"` : ''}`;
      }
      return `- feedback: positive=${s.positive}${s.comment ? `, comment="${s.comment}"` : ''}`;
    })
    .join('\n');

  return `Skill: ${skillName}
Evidence: ${evidenceSummary}

Recent signals (${signals.length}):
${signalSummary || '(none)'}

Current SKILL.md:
"""
${skillMdContent}
"""

Analyze the performance issue and propose specific changes. Format your response exactly as:

EVIDENCE: <one-line summary of what you found>

CHANGE:
FIELD: <description|triggers|requires|instructions>
RISK: <safe|risky>
ORIGINAL: <exact text to replace>
PROPOSED: <replacement text>
RATIONALE: <why this change>

Repeat CHANGE blocks for each change. If no changes needed, respond "No changes needed."

Risk classification:
- safe: description text tweaks or trigger keyword additions (auto-applied)
- risky: instruction rewrites, requires adjustments, or behavior changes (require human approval)`;
}

export function buildStaleAnalysisPrompt(
  skillName: string,
  skillMdContent: string,
  daysSinceLastInvocation: number,
): string {
  return `Skill "${skillName}" has not been invoked in ${daysSinceLastInvocation} days.

Current SKILL.md:
"""
${skillMdContent}
"""

This skill may have a stale description that no longer matches user intent. Review the description field:
- Does it clearly describe WHEN to use this skill?
- Are there relevant trigger keywords missing?
- Is the description broad enough to match real queries, but narrow enough not to misfire?

If the description can be improved, propose a CHANGE for the description field (risk: safe). If the description is fine, respond "No changes needed."`;
}

export function parseAnalyzerResponse(
  response: string,
  skillName: string,
): EvolutionProposal {
  const evidenceMatch = response.match(/^EVIDENCE:\s*(.+)$/m);
  const evidence = evidenceMatch ? evidenceMatch[1].trim() : 'unknown';

  const changeBlocks = response.split(/\n(?=CHANGE:)/);

  const changes: EvolutionChange[] = [];
  for (const block of changeBlocks) {
    const fieldMatch = block.match(/^FIELD:\s*(.+)$/m);
    const riskMatch = block.match(/^RISK:\s*(.+)$/m);
    const originalMatch = block.match(/^ORIGINAL:\s*(.+)$/m);
    const proposedMatch = block.match(/^PROPOSED:\s*(.+)$/m);
    const rationaleMatch = block.match(/^RATIONALE:\s*(.+)$/m);

    if (fieldMatch && riskMatch && originalMatch && proposedMatch) {
      const field = fieldMatch[1].trim();
      const risk = riskMatch[1].trim() as 'safe' | 'risky';
      if (
        (field === 'description' || field === 'triggers' || field === 'requires' || field === 'instructions') &&
        (risk === 'safe' || risk === 'risky')
      ) {
        changes.push({
          field,
          risk,
          original: originalMatch[1].trim(),
          proposed: proposedMatch[1].trim(),
          rationale: rationaleMatch ? rationaleMatch[1].trim() : '',
        });
      }
    }
  }

  return {
    skillName,
    skillDirPath: '',
    generatedAt: new Date().toISOString(),
    evidence,
    changes,
  };
}
