import { z } from 'zod';
import { browserAction } from './browser-tools.js';
import { computerAction, desktopRunAction, desktopFilesAction, desktopOpenAction, desktopRecordAction, desktopJobsAction, desktopDisplayAction, desktopReadScreenAction } from './computer-actions.js';
import { parseFailureReason } from './failure-recovery.js';
import { memoryInput } from './memory.js';
import { MissionBlocker, MissionDecision } from './missions.js';
import { questionInput } from './work-questions.js';
import { documentInput } from './document-tools.js';
import { PreparePostSchema } from './character-prepare.js';
import { ProposeCharacterSchema } from './character-setup.js';
import {ResultRequirementsSchema} from './goal-results.js';

export const actionSchema = z.discriminatedUnion('tool', [
  z.object({tool:z.literal('reconcile_message'),attemptId:z.string().uuid()}).strict(),
  z.object({tool:z.literal('send_message'),resultId:z.string().min(1).max(100),recipient:z.string().min(1).max(100),text:z.string().min(1).max(8000),attachmentPath:z.string().min(1).max(200).optional()}).strict(),
  z.object({tool:z.literal('declare_results'),requirements:ResultRequirementsSchema}).strict(),
  z.object({tool:z.literal('result_status')}).strict(),
  PreparePostSchema,
  ProposeCharacterSchema,
  browserAction,
  computerAction,
  desktopRunAction,
  desktopFilesAction,
  desktopOpenAction,
  desktopRecordAction,
  desktopJobsAction,
  desktopDisplayAction,
  desktopReadScreenAction,
  questionInput.extend({ tool: z.literal('ask_user_question') }).strict(),
  documentInput.extend({ tool: z.literal('create_document') }).strict(),
  z.object({tool:z.literal('background_start'),name:z.string().min(1).max(120),instruction:z.string().min(1).max(8000),targetAgentId:z.string().max(80).optional()}).strict(),
  z.object({tool:z.literal('background_status')}).strict(),
  z.object({tool:z.literal('background_continue'),id:z.string().uuid(),instruction:z.string().min(1).max(8000)}).strict(),
  z.object({tool:z.literal('delete_file'),path:z.string().min(1).max(200)}).strict(),
  z.object({tool:z.literal('rename_file'),path:z.string().min(1).max(200),destination:z.string().min(1).max(200)}).strict(),
  z.object({tool:z.literal('register_file'),path:z.string().min(1).max(200)}).strict(),
  z.object({ tool: z.literal('mission_items') }).strict(),
  z.object({ tool: z.literal('track_issue'), url: z.string().url().max(4000), disposition: z.enum(['selected', 'rejected']), reason: z.string().min(1).max(1000) }).strict(),
  z.object({ tool: z.literal('start_mission'), objective: z.string().min(1).max(8000), contractId: z.string().max(100), maxRuns: z.number().int().min(1).max(20).default(10), intervalMs: z.number().int().min(60000).max(604800000).default(300000) }).strict(),
  z.object({ tool: z.literal('create_routine'), name: z.string().trim().min(1).max(80), instruction: z.string().trim().min(1).max(8000), schedule: z.string().trim().min(1).max(200), timezone: z.string().trim().min(1).max(64).optional() }).strict(),
  z.object({ tool: z.literal('connect_obsidian_vault'), path: z.string().trim().min(3).max(1000) }).strict(),
  z.object({ tool: z.literal('request_account'), site: z.string().trim().min(1).max(300), reason: z.string().trim().min(1).max(600) }).strict(),
  z.object({ tool: z.literal('vault_list') }).strict(),
  z.object({ tool: z.literal('vault_import'), file: z.string().min(1).max(500), key: memoryInput.shape.key }).strict(),
  z.object({ tool: z.literal('vault_export'), key: memoryInput.shape.key }).strict(),
  z.object({ tool: z.literal('start_repository_work'), repository: z.string().min(3).max(300), request: z.string().min(1).max(8000), testCommand: z.string().min(1).max(2000), install: z.enum(['auto', 'npm', 'pip', 'none']).default('auto'),paths:z.array(z.string().min(1).max(200)).min(1).max(100).optional(),workingTree:z.boolean().optional() }).strict(),
  z.object({ tool: z.literal('web_read'), url: z.string().url().max(4000) }).strict(),
  z.object({ tool: z.literal('web_search'), query: z.string().min(1).max(1000) }).strict(),
  z.object({ tool: z.literal('github_issues'), query: z.string().min(1).max(1000) }).strict(),
  z.object({ tool: z.literal('answer'), text: z.string().min(1).max(24000), citations: z.array(z.object({ sourceId: z.string().max(80), quote: z.string().min(12).max(2000) }).strict()).max(12).default([]) }).strict(),
  z.object({ tool: z.literal('plan'), steps: z.array(z.string().min(1).max(500)).min(1).max(8) }).strict(),
  z.object({
    tool: z.literal('todo_write'),
    items: z.array(z.object({
      id: z.string().optional(),
      text: z.string().min(1).max(500),
      status: z.enum(['pending', 'in_progress', 'completed']),
    })).max(20),
  }).strict(),
  z.object({ tool: z.literal('read'), path: z.string().max(200), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(10000).optional() }).strict(),
  z.object({ tool: z.literal('edit'), path: z.string().max(200), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() }).strict(),
  z.object({ tool: z.literal('list'), path: z.string().max(200).optional(), depth: z.number().int().min(1).max(4).optional() }).strict(),
  z.object({ tool: z.literal('glob'), pattern: z.string().min(1).max(200) }).strict(),
  z.object({ tool: z.literal('grep'), pattern: z.string().min(1).max(500), path: z.string().max(200).optional(), glob: z.string().max(100).optional(), ignoreCase: z.boolean().optional() }).strict(),
  z.object({ tool: z.literal('diff'), path: z.string().max(200).optional() }).strict(),
  z.object({ tool: z.literal('source'), id: z.string().min(1).max(80) }).strict(),
  z.object({ tool: z.literal('write'), path: z.string().max(200), content: z.string().max(64_000) }).strict(),
  z.object({ tool: z.literal('run'), command: z.string().min(1).max(2000) }).strict(),
  z.object({ tool: z.literal('verify') }).strict(),
  z.object({ tool: z.literal('mcp'), server: z.string().max(100), name: z.string().max(100), args: z.record(z.unknown()) }).strict(),
  z.object({ tool: z.literal('finish'), mission: MissionDecision.optional() }).strict(),
  z.object({ tool: z.literal('remember'), note: memoryInput }).strict(),
  z.object({ tool: z.literal('recall'), query: z.string().min(1).max(1000) }).strict(),
  z.object({ tool: z.literal('compact') }).strict(),
  z.object({ tool: z.literal('skill'), name: z.string().min(1).max(100) }).strict(),
  z.object({
    tool: z.literal('delegate'),
    taskName: z.string().trim().min(1).max(120),
    instruction: z.string().trim().min(1).max(8000),
    targetAgentId: z.string().trim().min(1).max(80).optional(),
    maxTurns: z.number().int().min(1).max(24).optional().default(12),
  }).strict(),
  /**
   * Ask the operator to do one thing the bot cannot do itself, then carry on.
   *
   * A 2FA code, a CAPTCHA or a payment confirmation exists precisely to require the
   * person. Before this, hitting one ended the run and the operator had to start over.
   * The run now waits, the operator acts on the bot's own desktop, and the same run
   * continues - which is the difference between a task that stalls and one that finishes.
   */
  z.object({
    tool: z.literal('request_human'),
    what: z.string().trim().min(1).max(2000),
    why: z.string().trim().min(1).max(1000),
    url: z.string().url().max(4000).optional(),
  }).strict(),
  z.object({ tool: z.literal('block'), reason: z.string().min(1).max(2000), blocker: MissionBlocker.optional() }).strict(),
]);

export type WorkAction = z.infer<typeof actionSchema>;

/**
 * A model's own tool-call syntax, written as text instead of a JSON action.
 *
 * DeepSeek through OpenRouter answers with `<｜DSML｜ invoke name="web_search">`
 * blocks; other models use `<invoke name=...>` or `<tool_call>{...}</tool_call>`.
 * Read as conversation, that markup was posted to the owner as a routine's
 * "result". It is recognised here and translated into the action it names, or
 * refused so the model is asked again - never treated as an answer.
 */
// The delimiters vary between runs of the same model: `<｜DSML｜`, `<｜｜DSML｜｜`, `<|DSML|`.
const NATIVE_TOOL_MARKUP = /<\s*\/?\s*[｜|]+\s*DSML\s*[｜|]+|<\/?tool_call>|<[｜|]+\s*tool[▁_ ]call|<function_calls>|<invoke name=|<function=/;
export function nativeToolCall(content: string): { action?: Record<string, unknown>; count: number } | null {
  if (!NATIVE_TOOL_MARKUP.test(content)) return null;
  const dsml = String.raw`(?:[｜|]+\s*DSML\s*[｜|]+\s*)?`;
  const invokes: Array<{ name: string; params: Record<string, unknown> }> = [];
  for (const match of content.matchAll(new RegExp(String.raw`<${dsml}invoke name="([^"]+)"\s*>([\s\S]*?)<\/${dsml}invoke>`, 'g'))) {
    const params: Record<string, unknown> = {};
    for (const parameter of match[2].matchAll(new RegExp(String.raw`<${dsml}parameter name="([^"]+)"(?:\s+string="(true|false)")?\s*>([\s\S]*?)<\/${dsml}parameter>`, 'g'))) {
      const raw = parameter[3].trim();
      if (parameter[2] === 'false') {
        try { params[parameter[1]] = JSON.parse(raw); continue; } catch { /* a malformed value stays text */ }
      }
      params[parameter[1]] = raw;
    }
    invokes.push({ name: match[1], params });
  }
  // DeepSeek's other format: <｜tool▁call▁begin｜>function<｜tool▁sep｜>web_search ```json {...} ```<｜tool▁call▁end｜>
  for (const match of content.matchAll(/<[｜|]+\s*tool▁call▁begin\s*[｜|]+>\s*(?:function)?\s*<[｜|]+\s*tool▁sep\s*[｜|]+>\s*([\w.-]+)\s*(?:```(?:json)?\s*)?(\{[\s\S]*?\})\s*(?:```)?\s*<[｜|]+\s*tool▁call▁end\s*[｜|]+>/g)) {
    try {
      const args = JSON.parse(match[2]) as unknown;
      if (args && typeof args === 'object' && !Array.isArray(args)) invokes.push({ name: match[1], params: args as Record<string, unknown> });
    } catch { /* not a readable call */ }
  }
  for (const match of content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
    try {
      const call = JSON.parse(match[1]) as { name?: unknown; arguments?: unknown; parameters?: unknown };
      const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments ?? call.parameters ?? {};
      if (typeof call.name === 'string' && args && typeof args === 'object') invokes.push({ name: call.name, params: args as Record<string, unknown> });
    } catch { /* not a readable call */ }
  }
  const first = invokes[0];
  return { action: first ? { ...first.params, tool: first.name } : undefined, count: invokes.length };
}

/**
 * Recover one complete JSON object from a model envelope without guessing
 * between actions. Providers sometimes put a sentence or a markdown fence
 * around otherwise valid JSON. That prose is never executed. A second JSON
 * object, an array wrapper, or another tool-shaped fragment remains ambiguous
 * and is refused.
 */
/** Actions that only read. A batch made entirely of these can run its first without choosing between effects. */
export const READ_ONLY_TOOLS = new Set<string>([
  'web_search',
  'web_read',
  'github_issues',
  'recall',
  'source',
  'vault_list',
  'mission_items',
  'read',
  'list',
  'glob',
  'grep',
  'diff',
]);

/** Tools safe to run concurrently during a native tool calling turn. */
export const NATIVE_PARALLEL_TOOLS = new Set<string>([
  ...READ_ONLY_TOOLS,
  'plan',
  'todo_write',
]);

export function parseStructuredAction(content: string): { action: WorkAction; normalized: boolean; ignoredChars: number; batched?: number } {
  const trimmed = content.trim();
  try {
    return { action: actionSchema.parse(JSON.parse(trimmed)), normalized: false, ignoredChars: 0 };
  } catch (error) {
    // A complete JSON value with the wrong schema must stay rejected. Searching
    // inside it could turn a forbidden wrapper into an executable nested action.
    if (!(error instanceof SyntaxError)) throw error;
  }

  const ranges: Array<{ start: number; end: number; value: unknown }> = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < content.length; index++) {
    const character = content[index];
    if (start < 0) {
      if (character === '{') { start = index; depth = 1; quoted = false; escaped = false; }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') depth++;
    else if (character === '}' && --depth === 0) {
      const end = index + 1;
      try { ranges.push({ start, end, value: JSON.parse(content.slice(start, end)) }); }
      catch { /* malformed brace-delimited prose is not an action candidate */ }
      start = -1;
    }
  }

  if (ranges.length > 1) {
    // DeepSeek batches its searches and page reads as several JSON objects in one
    // reply. When every object is a read-only action there is nothing harmful to
    // choose between: the first runs and the model is told the rest did not. A
    // batch with any action that changes something, anything that is not an
    // action, or an array wrapper stays refused.
    const actions = ranges.map((range) => actionSchema.safeParse(range.value));
    const wrapper = content.slice(0, ranges[0].start) + content.slice(ranges.at(-1)!.end);
    const first = actions[0];
    if (first.success && actions.every((parsed) => parsed.success && READ_ONLY_TOOLS.has(parsed.data.tool)) && !/[\[\]]/.test(wrapper)) {
      return { action: first.data, normalized: true, ignoredChars: Buffer.byteLength(content) - Buffer.byteLength(content.slice(ranges[0].start, ranges[0].end)), batched: ranges.length };
    }
  }
  if (ranges.length !== 1) {
    throw new Error(ranges.length > 1
      ? 'The response contained more than one JSON object, so no action was executed. Send one action per reply.'
      : parseFailureReason(content));
  }
  const [candidate] = ranges;
  const outside = content.slice(0, candidate.start) + content.slice(candidate.end);
  if (/[\[\]{}]/.test(outside) || /"tool"\s*:/.test(outside)) {
    throw new Error('The response contained an ambiguous JSON envelope, so no action was executed.');
  }
  return {
    action: actionSchema.parse(candidate.value),
    normalized: true,
    ignoredChars: Buffer.byteLength(outside),
  };
}
