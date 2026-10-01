import type { ChatMessage, ToolDefinition } from '../evals/llm-client.js';
import { utf8Prefix } from './workspace-guidance.js';

/** Heuristic size of the actual request envelope, including native arguments and tool schemas. */
export function contextChars(systemPrompt: string, messages: ChatMessage[], tools?: ToolDefinition[]): number {
  // Image bytes are transmitted as content parts, not tokenized base64 text. Reserve a conservative
  // allowance per bounded image; provider-reported usage still reconciles the actual cost.
  const imageChars = messages.reduce((n,m)=>n+(m.images?.length ?? 0)*24000,0);
  return systemPrompt.length + JSON.stringify(messages.map(({images,...m})=>m)).length + imageChars + (tools?.length ? JSON.stringify(tools).length : 0);
}

/** Keep both the beginning and the diagnostic tail, even for one huge line. */
export function pruneToolResult(content: string): string {
  if (Buffer.byteLength(content) <= 2048) return content;
  const head = utf8Prefix(content, 900);
  const tailBytes = Buffer.from(content);
  let start = Math.max(0, tailBytes.length - 900);
  while (start < tailBytes.length && (tailBytes[start] & 0xc0) === 0x80) start++;
  const tail = tailBytes.subarray(start).toString('utf8');
  const omitted = Buffer.byteLength(content) - Buffer.byteLength(head) - Buffer.byteLength(tail);
  return `${head}\n... (${omitted} bytes pruned from earlier turn; reread the source for full content) ...\n${tail}`;
}

/** Fit observations to the actual request budget; never truncate operator instructions.
 * Tool IDs/pairs remain intact. Full evidence remains in the run event store.
 */
export function fitObservationBudget(system: string, messages: ChatMessage[], tools?: ToolDefinition[], target = 90_000): ChatMessage[] {
  const result = messages.map(m => ({ ...m }));
  const observations = result.map((m, i) => ({ m, i })).filter(({m,i}) => i > 0 && (m.role === 'tool' || (m as ChatMessage & {observation?:boolean}).observation));
  for (const {m} of observations) {
    try {
      const value = JSON.parse(m.content);
      if (typeof value.snapshot === 'string' && value.snapshot === value.summary) {
        value.summary = 'Browser observation; accessibility text is in snapshot.';
        m.content = JSON.stringify(value);
      }
    } catch { /* Plain text observations need no JSON normalization. */ }
  }
  // Oldest first; retain the newest complete observation whenever it fits.
  for (const {m} of observations) {
    if (contextChars(system, result, tools) <= target) break;
    m.content = pruneToolResult(m.content);
    if (m !== observations.at(-1)?.m) delete m.images;
  }
  return result;
}

export function isContextOverflow(error: unknown): boolean {
  const e=error as {message?:string;rawBody?:string;status?:number;details?:{status?:number}};
  const status=e?.status??e?.details?.status;
  return (status===400||status===413||status===422) && /context[_ ](?:length|window)|maximum context|too many (?:input )?tokens|prompt (?:is )?too long|input.*exceeds.*token/i.test(`${e.message??''} ${e.rawBody??''}`);
}

/** Lossless operator instructions; old tool payloads and assistant reasoning may be dropped. */
export function recoverOverflow(messages: ChatMessage[]): ChatMessage[] {
  const flattened=messages.map(m=>m.role==='assistant'&&m.toolCalls?.length?{...m,toolCalls:undefined,content:`${m.content}\nPrevious tool calls (do not replay): ${m.toolCalls.map(t=>t.name).join(', ')}`} : m.role==='tool'?{role:'user' as const,content:`Tool observation: ${pruneToolResult(m.content)}`,observation:true}:m);
  const cutoff=Math.max(1,flattened.length-2);
  return flattened.filter((m,i)=>i===0||i>=cutoff||(m.role==='user'&&!(m as ChatMessage&{observation?:boolean}).observation))
    .map((m,i)=>i===0||m.role==='user'&&!(m as ChatMessage&{observation?:boolean}).observation?m:{...m,content:pruneToolResult(m.content)});
}
