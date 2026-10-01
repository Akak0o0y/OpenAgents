import type { EventRow } from './transport.js';
import { formatCount } from './numbers.js';

type Payload = Record<string, unknown>;

function parse(event: EventRow): Payload {
  try {
    const value = JSON.parse(event.payload_json);
    return value && typeof value === 'object' ? (value as Payload) : {};
  } catch {
    return {};
  }
}

const text = (value: unknown, max = 160): string | undefined =>
  typeof value === 'string' && value.trim() ? (value.length > max ? `${value.slice(0, max)}…` : value) : typeof value === 'number' ? String(value) : undefined;

export const TITLES: Record<string, string> = {
  MODEL_MEASUREMENT:'Model usage and timing recorded',RESOURCE_WAIT:'Waiting for a work resource',
  FLOW_RECORDED:'Learned proven browser steps',FLOW_REJECTED:'Browser steps were not reusable',FLOW_PLAYBACK_STARTED:'Started learned browser steps',FLOW_STEP:'Completed a learned step',FLOW_COMPOSED:'Prepared text for learned steps',FLOW_FALLBACK:'Returned to the model loop',FLOW_ATTENTION:'Learned steps need an account check',
  CHARACTER_PROPOSED:'Prepared a character proposal',CHARACTER_COMPOSED:'Drafted in character',CHARACTER_REVIEWED:'Reviewed a character draft',CHARACTER_ADMITTED:'Prepared checked text for submission',
  PROMPT_ASSEMBLED: 'Instructions assembled',
  TASK_STARTED: 'Run started',
  HISTORY_APPENDED: 'Working context updated',
  STEER_APPLIED: 'Your steering message was applied',
  MEMORY_WRITTEN: 'Remembered something',
  MEMORY_RECALLED: 'Recalled from memory',
  CONTEXT_COMPACTED: 'Context compacted',
  WORK_PLAN: 'Made a plan',
  WORK_ACTION: 'Took an action',
  OPENCODE_SESSION: 'OpenCode session',
  TOOL_CALL: 'Used a tool',
  WORK_VERIFIED: 'Checked the work',
  TURN_COMPLETED: 'Finished a step',
  RESPONSE_FORMAT_REJECTED: 'A reply was malformed and refused',
  CHAT_REPLY: 'Posted a reply',
  ARTIFACT_CREATED: 'Saved a file',
  WORK_REPORT: 'Reported the result',
  THRASH_WARNING: 'Repeated failing actions',
  PROTECTED_FILES_RESTAGED: 'Protected files restored',
  PROVIDER_RETRY: 'Retried the model provider',
  SUBAGENT_DELEGATED: 'Delegated subtask',
  SUBAGENT_COMPLETED: 'Subtask finished',
  TASK_COMPLETED: 'Run completed',
  TASK_FAILED: 'Run failed',
  TASK_ABORTED: 'Run stopped',
  TASK_CRASHED: 'Run crashed',
  // Posting (spec 10.1). "x.com" is fixed wording, whatever the probe origin.
  PUBLISH_ATTEMPTED: 'Sent a post to x.com',
  // Anything but a confirmed or refused response leaves the post unconfirmed.
  PUBLISH_OBSERVED: 'Post not confirmed',
  // Only a `present` verdict found the post.
  PUBLISH_RECONCILED: 'Post not found on the page',
  // A refusal reason this build does not know.
  PUBLISH_REFUSED: 'Held back a post',
  EXTERNAL_ACTION_ACKNOWLEDGED: 'Owner checked it',
  CHARACTER_REFUSED: 'Held back text not prepared in character',
  CHARACTER_POSTED: 'Recorded post outcome',
};

/** A Map, so an unexpected reason such as "constructor" cannot reach Object.prototype. */
const PUBLISH_REFUSED_TITLES = new Map<string, string>([
  ['budget', 'Held back a second post'],
  ['duplicate-text', 'Held back a repeated post'],
  ['duplicate-target', 'Held back a repeated post'],
  ['expected-mismatch', 'Held back a post that did not match'],
  ['character-unadmitted', 'Held back a post not prepared in character'],
  ['character-unverifiable', 'Held back a post that could not be matched exactly'],
  ['internal', 'Held back a post after an internal error'],
]);

/** A link to the post, only for a web address. */
const postLink = (value: unknown): { href: string; label: string } | undefined =>
  typeof value === 'string' && /^https?:\/\//i.test(value) ? { href: value, label: 'Open' } : undefined;

/** A readable line for one event. Unknown shapes fall back to their most telling field. */
export function describeEvent(event: EventRow): { title: string; detail?: string; link?: { href: string; label: string } } {
  const p = parse(event);
  const title = TITLES[event.event_type] ?? event.event_type.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  switch (event.event_type) {
    case 'PROMPT_ASSEMBLED':
      return { title, detail: [typeof p.promptChars === 'number' ? `${formatCount(p.promptChars)} characters` : undefined, text(p.contractId), text(p.executor)].filter(Boolean).join(' · ') || undefined };
    case 'HISTORY_APPENDED':
      return { title, detail: typeof p.messageCount === 'number' ? `${p.messageCount} messages${typeof p.chars === 'number' ? `, ${formatCount(p.chars)} characters` : ''}` : undefined };
    case 'WORK_PLAN':
      return { title, detail: Array.isArray(p.steps) ? (p.steps as unknown[]).map((step) => String(step)).join(' → ').slice(0, 260) : undefined };
    case 'TOOL_CALL': {
      const tool = text(p.tool) ?? text(p.name) ?? 'tool';
      return { title: `${title}: ${tool}`, detail: text(p.summary, 220) ?? text(p.status) };
    }
    case 'WORK_VERIFIED':
      return { title, detail: p.passed === true ? 'Passed' : p.passed === false ? 'Did not pass' : text(p.summary) };
    case 'ARTIFACT_CREATED': {
      const file = text(p.path) ?? 'file';
      return {
        title: `${title}: ${file}`, detail: typeof p.bytes === 'number' ? `${formatCount(p.bytes)} bytes` : undefined,
        link: typeof p.downloadUrl === 'string' ? { href: p.downloadUrl, label: 'Open' } : undefined
      };
    }
    case 'MEMORY_WRITTEN':
      return { title, detail: text(p.key) ?? text((p.note as Payload | undefined)?.key) ?? text(p.text) };
    case 'MEMORY_RECALLED':
      return { title, detail: Array.isArray(p.notes) ? `${p.notes.length} notes` : typeof p.count === 'number' ? `${p.count} notes` : text(p.query) };
    case 'CONTEXT_COMPACTED':
      return {
        title,
        detail: [
          typeof p.mode === 'string' ? `${p.mode} mode` : undefined,
          typeof p.beforeChars === 'number' && typeof p.afterChars === 'number'
            ? `${formatCount(p.beforeChars)} → ${formatCount(p.afterChars)} chars`
            : undefined,
        ].filter(Boolean).join(' · ') || undefined,
      };
    case 'SUBAGENT_DELEGATED':
      return {
        title,
        detail: [
          text(p.taskName),
          typeof p.depth === 'number' ? `depth ${p.depth}` : undefined,
          text(p.targetAgentId) ? `agent: ${p.targetAgentId}` : undefined,
        ].filter(Boolean).join(' · ') || undefined,
      };
    case 'SUBAGENT_COMPLETED':
      return {
        title,
        detail: [
          text(p.taskName),
          text(p.outcome),
          typeof p.turns === 'number' ? `${p.turns} turns` : undefined,
        ].filter(Boolean).join(' · ') || undefined,
      };
    // Posting lines never show text hashes, reply targets or publish ids.
    case 'PUBLISH_ATTEMPTED':
    case 'EXTERNAL_ACTION_ACKNOWLEDGED':
    case 'CHARACTER_REFUSED':
    case 'CHARACTER_POSTED':
      return { title };
    case 'PUBLISH_OBSERVED':
      if (p.outcome === 'confirmed') return { title: 'x.com confirmed the post', link: postLink(p.postUrl) };
      return { title: p.outcome === 'rejected' ? 'x.com refused the post' : title, detail: text(p.reason) };
    case 'PUBLISH_RECONCILED':
      return p.verdict === 'present' ? { title: 'Found the post on the page', link: postLink(p.postUrl) } : { title };
    case 'PUBLISH_REFUSED':
      return { title: PUBLISH_REFUSED_TITLES.get(String(p.reason)) ?? title };
    default:
      return { title, detail: text(p.summary, 220) ?? text(p.reason, 220) ?? text(p.outcome) ?? text(p.message, 220) ?? text(p.source) ?? text(p.status) };
  }
}
