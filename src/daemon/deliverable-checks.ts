import { createHash } from 'node:crypto';
import { z } from 'zod';

export interface EvidenceSource { id: string; origin: string; text: string; capturedAt: string; sha256: string }
export function evidenceSource(id: string, origin: string, text: string): EvidenceSource {
  return { id, origin, text, capturedAt: new Date().toISOString(), sha256: createHash('sha256').update(text).digest('hex') };
}
const shortText = z.string().trim().min(1).max(1000);
const reportSchema = z.object({
  title: shortText,
  findings: z.array(z.object({ claim: shortText, evidence: z.array(z.object({ sourceId: z.string(), quote: z.string().min(12).max(2000) }).strict()).min(1).max(5) }).strict()).min(1).max(30),
  limitations: z.array(shortText).min(1).max(12),
}).strict();
const planSchema = z.object({
  title: shortText,
  tasks: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), title: shortText, doneWhen: shortText,
    priority: z.number().int().min(1).max(3), dependsOn: z.array(z.string()).max(20), due: z.string().datetime({ offset: true }).optional() }).strict()).min(1).max(40),
  limitations: z.array(shortText).min(1).max(12),
}).strict();

// Render model strings as literal text, never executable HTML or invented links.
const literal = (text: string) => text.replace(/[\\`*_{}\[\]()#+.!<>|~-]/g, '\\$&').replace(/\r?\n/g, ' ');

export function parseJsonContent(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch (initialError) {
    const codeFenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (codeFenceMatch) {
      try {
        return JSON.parse(codeFenceMatch[1].trim());
      } catch {
        // Fall through to boundary extraction
      }
    }
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      } catch {
        // Fall through to array check
      }
    }
    const firstBracket = trimmed.indexOf('[');
    const lastBracket = trimmed.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      try {
        return JSON.parse(trimmed.slice(firstBracket, lastBracket + 1));
      } catch {
        // Fall through to original error
      }
    }
    throw initialError;
  }
}

export function checkDeliverable(kind: 'report' | 'plan', content: string, sources: EvidenceSource[]): Record<string, string> {
  const value = parseJsonContent(content);
  if (kind === 'report') {
    const report = reportSchema.parse(value);
    for (const finding of report.findings) for (const evidence of finding.evidence) {
      const source = sources.find(source => source.id === evidence.sourceId);
      if (!source || !source.text.includes(evidence.quote)) throw new Error(`Citation ${evidence.sourceId} does not match captured source text. Use an exact quote from a source provided by a tool or the request.`);
    }
    return {
      'report.json': JSON.stringify(report, null, 2),
      'report.md': `# ${literal(report.title)}\n\nSource references and exact quotations were checked. Claims are model interpretations, not independent fact verification.\n\n` +
        report.findings.map(f => `- ${literal(f.claim)}\n` + f.evidence.map(e => `  - ${literal(e.sourceId)}: “${literal(e.quote)}”`).join('\n')).join('\n\n') +
        `\n\n## Limitations\n\n${report.limitations.map(s => `- ${literal(s)}`).join('\n')}\n`,
      'sources.json': JSON.stringify(sources, null, 2),
    };
  }
  const plan = planSchema.parse(value);
  const ids = new Set(plan.tasks.map(task => task.id));
  if (ids.size !== plan.tasks.length) throw new Error('Plan task IDs must be unique.');
  const visited = new Set<string>(); const visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('Plan dependencies contain a cycle.');
    if (visited.has(id)) return;
    if (!ids.has(id)) throw new Error(`Unknown plan dependency ${id}.`);
    visiting.add(id);
    for (const dependency of plan.tasks.find(task => task.id === id)!.dependsOn) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
  return {
    'plan.json': JSON.stringify(plan, null, 2),
    'plan.md': `# ${literal(plan.title)}\n\nThis is a proposed plan. Structure, timestamps and dependencies were checked; no calendar events or external tasks were created.\n\n` +
      plan.tasks.map(t => `- [ ] ${literal(t.title)} (${t.id}, priority ${t.priority})\n  - Done when: ${literal(t.doneWhen)}\n  - Dependencies: ${t.dependsOn.join(', ') || 'none'}${t.due ? `\n  - Due: ${t.due}` : ''}`).join('\n\n') +
      `\n\n## Limitations\n\n${plan.limitations.map(s => `- ${literal(s)}`).join('\n')}\n`,
  };
}

export const REPORT_GUIDANCE = 'Write report.json with {"title":"...","findings":[{"claim":"...","evidence":[{"sourceId":"request","quote":"exact quotation, at least 12 characters"}]}],"limitations":["..."]}. All findings need matching quotations. Tool responses provide source IDs. Only use captured sources; report limitations and uncertainty. Then verify and finish.';
export const PLAN_GUIDANCE = 'Write plan.json with {"title":"...","tasks":[{"id":"t1","title":"...","doneWhen":"observable acceptance condition","priority":1,"dependsOn":[]}],"limitations":["..."]}. Use unique IDs, valid dependencies without cycles, and omit due if no date is known. Then verify and finish.';
