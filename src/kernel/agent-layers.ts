/**
 * ECC 12-Layer Agent Stack Taxonomy
 *
 * The single source of truth for what OpenAgents can actually observe about its
 * own agents. Cortex renders from this table, so the table must describe the
 * runtime as it IS, not as the architecture diagram wishes it were.
 *
 * `status` is a claim about instrumentation, not about quality:
 *   live    - the runtime emits at least one event that is direct evidence of
 *             this layer doing its job.
 *   partial - some evidence exists, but it is inferred, executor-specific, or
 *             incomplete.
 *   hollow  - the subsystem DOES NOT EXIST in this codebase. Cortex draws these
 *             dashed and never animates them.
 *
 * The hollow entries are the point. A panel that pulses all twelve rings would
 * be decoration; one that shows three of them dark is a diagnostic that tells
 * the operator what their agent stack is missing. Do not promote a layer to
 * `live` until an event that proves it is emitted and asserted in a test.
 */

export type LayerId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export type LayerStatus = 'live' | 'partial' | 'hollow';

export interface AgentLayer {
  id: LayerId;
  name: string;
  status: LayerStatus;
  /** What the layer is responsible for, in this system's terms. */
  description: string;
  /** Where the evidence comes from, or why there is none. */
  evidence: string;
  /** Event types that are direct evidence of this layer. Empty when hollow. */
  eventTypes: readonly string[];
}

export const AGENT_LAYERS: readonly AgentLayer[] = [
  {
    id: 1,
    name: 'System Prompt',
    status: 'live',
    description: 'Standing instructions assembled before any turn.',
    evidence: 'agents.system_prompt; AgentLoop systemPrompt; OpenCodeExecutor.buildPrompt()',
    eventTypes: ['PROMPT_ASSEMBLED', 'TASK_STARTED', 'WORKSPACE_INSTRUCTIONS_LOADED'],
  },
  {
    id: 2,
    name: 'Session History',
    status: 'live',
    description: 'Prior turns of this task carried forward to the model.',
    evidence:
      'AgentLoop messages[] -> LLMRequest.messages -> buildConversation(). ' +
      'Was BROKEN until the layer-2 audit fix: history accumulated but only the ' +
      'last message was transmitted.',
    eventTypes: ['HISTORY_APPENDED', 'STEER_APPLIED'],
  },
  {
    id: 3,
    name: 'Long-Term Memory',
    status: 'live',
    description: 'Durable knowledge carried across tasks and sessions.',
    evidence: 'Bot-scoped notes persist in SQLite with origin and source-run identity. Model writes cannot overwrite operator notes.',
    eventTypes: ['MEMORY_WRITTEN'],
  },
  {
    id: 4,
    name: 'Distillation',
    status: 'partial',
    description: 'Compression of past context into reusable artifacts.',
    evidence: 'Bounded model summaries retain execution history with deterministic checkpoint fallback. Operator steering, workspace instructions, source references and recent tool pairs are retained; summaries are model-generated, not independently verified.',
    eventTypes: ['CONTEXT_COMPACTED'],
  },
  {
    id: 5,
    name: 'Active Recall',
    status: 'live',
    description: 'Retrieval of stored knowledge into the working prompt.',
    evidence: 'Bounded term matching retrieves only notes belonging to the active bot, with recorded keys and provenance.',
    eventTypes: ['MEMORY_RECALLED'],
  },
  {
    id: 6,
    name: 'Tool Selection',
    status: 'partial',
    description: 'Deciding which tool to invoke.',
    evidence:
      'OpenCode NDJSON sessions and explicit WorkRuntime actions. WORK_PLAN stores public steps, not private reasoning.',
    eventTypes: ['OPENCODE_SESSION', 'WORK_ACTION', 'WORK_PLAN', 'WORK_TODO', 'SUBAGENT_DELEGATED', 'WORKSPACE_SKILL_LOADED','FLOW_RECORDED','FLOW_REJECTED','FLOW_PLAYBACK_STARTED','FLOW_STEP','FLOW_COMPOSED','FLOW_FALLBACK','FLOW_ATTENTION','CHARACTER_PROPOSED','CHARACTER_COMPOSED','CHARACTER_REVIEWED','CHARACTER_ADMITTED'],
  },
  {
    id: 7,
    name: 'Tool Execution',
    status: 'live',
    description: 'Running the tool and capturing its real output.',
    evidence:
      'TOOL_CALL is emitted for every MCP invocation - including refused and failed ones - ' +
      'by McpRegistry. COVERAGE IS PARTIAL and worth naming: the test container exit code is ' +
      'still only visible as a side-effect of TURN_COMPLETED, and opencode internal tool ' +
      'calls are NOT parsed, because that envelope has never been confirmed against a live ' +
      'successful session and a guessed parser would invent tool calls. PUBLISH_OBSERVED is ' +
      'the publish response the site returned for a post the browser sent, and PUBLISH_RECONCILED ' +
      'is the read-only page check that looked for that post afterwards.',
    eventTypes: ['TOOL_CALL', 'WORK_VERIFIED', 'SUBAGENT_COMPLETED', 'PUBLISH_OBSERVED', 'PUBLISH_RECONCILED', 'CHARACTER_POSTED'],
  },
  {
    id: 8,
    name: 'Tool Interpretation',
    status: 'partial',
    description: 'Reading tool output and acting on it.',
    evidence:
      'Inferred only: test output is fed back as the next user message. No event records what the model concluded from it.',
    eventTypes: [],
  },
  {
    id: 9,
    name: 'Answer Shaping',
    status: 'live',
    description: 'Turning the raw completion into the artifact the system wants.',
    evidence:
      'extractFilesFromResponse(); parseOpenCodeStream(). A fence-less reply is rejected, not written as prose.',
    eventTypes: ['TURN_COMPLETED', 'RESPONSE_FORMAT_REJECTED', 'CHAT_REPLY', 'ARTIFACT_CREATED', 'WORK_REPORT'],
  },
  {
    id: 10,
    name: 'Platform Rendering',
    status: 'live',
    description: 'Delivering the result to the operator surface.',
    evidence: 'AgentStore event sink -> DaemonWsServer.broadcast(); the console and Cortex consume it.',
    eventTypes: [],
  },
  {
    id: 11,
    name: 'Hidden Repair Loops',
    status: 'live',
    description: 'Retries, restagings and thrash detection that run without being asked.',
    evidence: 'ThrashDetector; llm-client attemptCount retries; OpenCodeExecutor protected-file restaging.',
    eventTypes: ['THRASH_WARNING', 'PROTECTED_FILES_RESTAGED', 'PROVIDER_RETRY'],
  },
  {
    id: 12,
    name: 'Persistence',
    status: 'live',
    description: 'What survives the process: verdicts, costs, and the audit log.',
    evidence: 'task_runs, execution_events, cost_reservations; boot crash sweep.',
    eventTypes: ['TASK_COMPLETED', 'TASK_FAILED', 'TASK_ABORTED', 'TASK_CRASHED'],
  },
] as const;

const BY_ID = new Map<LayerId, AgentLayer>(AGENT_LAYERS.map((l) => [l.id, l]));

export function getLayer(id: LayerId): AgentLayer {
  const layer = BY_ID.get(id);
  if (!layer) {
    throw new Error(`Unknown agent layer id: ${id}`);
  }
  return layer;
}

/**
 * The single mapping point from an emitted event to the layer it evidences.
 *
 * Exactly one layer per event: an event tagged with two layers would let Cortex
 * animate a hollow ring by association, which is the failure mode the hollow
 * rule exists to prevent. Where a signal genuinely spans layers (a tool call is
 * selection AND execution), it is attributed to the layer whose work the event
 * PROVES happened - execution, because the output is observed, whereas the
 * selection reasoning is not.
 *
 * Returns null for an unmapped event type. Null is a legitimate answer, not an
 * error: an untagged event is still recorded and still readable, it just does
 * not light up a ring.
 */
export function layerForEvent(eventType: string): LayerId | null {
  switch (eventType) {
    case 'MODEL_MEASUREMENT': return 8;
    case 'RESOURCE_WAIT': return 1;
    case 'PROMPT_ASSEMBLED':
    case 'WORKSPACE_INSTRUCTIONS_LOADED':
    case 'TASK_STARTED':
      return 1;

    // A steer appends a real user message to the transmitted conversation, so it
    // is genuine layer-2 evidence, not merely an operator action.
    case 'MEMORY_WRITTEN': return 3;
    case 'CONTEXT_COMPACTED': return 4;
    case 'MEMORY_RECALLED': return 5;
    case 'HISTORY_APPENDED':
    case 'STEER_APPLIED':
      return 2;

    case 'OPENCODE_SESSION':
    case 'WORK_ACTION':
    case 'FLOW_PLAYBACK_STARTED':
    case 'FLOW_STEP':
    case 'FLOW_COMPOSED':
    case 'FLOW_FALLBACK':
    case 'FLOW_ATTENTION':
    case 'FLOW_RECORDED':
    case 'FLOW_REJECTED':
    case 'CHARACTER_PROPOSED':
    case 'CHARACTER_COMPOSED':
    case 'CHARACTER_REVIEWED':
    case 'CHARACTER_ADMITTED':
    case 'WORK_PLAN':
    case 'WORK_TODO':
    case 'SUBAGENT_DELEGATED':
    case 'WORKSPACE_SKILL_LOADED':
      return 6;

    case 'EXTERNAL_ACTION_FINISHED':
    case 'TOOL_CALL':
    case 'WORK_VERIFIED':
    case 'SUBAGENT_COMPLETED':
    // The site's response to a sent post, and the page check for it: observed output.
    case 'PUBLISH_OBSERVED':
    case 'PUBLISH_RECONCILED':
    case 'CHARACTER_POSTED':
      return 7;

    case 'TURN_COMPLETED':
    case 'RESPONSE_FORMAT_REJECTED':
    case 'CHAT_REPLY':
    case 'ARTIFACT_CREATED':
    case 'WORK_REPORT':
      return 9;

    case 'THRASH_WARNING':
    case 'PROTECTED_FILES_RESTAGED':
    case 'PROVIDER_RETRY':
      return 11;

    case 'TASK_COMPLETED':
    case 'TASK_FAILED':
    case 'TASK_ABORTED':
    case 'TASK_CRASHED':
      return 12;

    // APPROVAL_REQUESTED / APPROVAL_DECIDED deliberately fall through to null.
    // They record a HUMAN decision, not an agent cognitive layer, and attributing
    // one to a ring would light the stack from something the agent did not do.
    // The same holds for three Stage 1 records that prove no layer's work:
    // PUBLISH_ATTEMPTED is an intent record written before the request leaves
    // Chrome, with no observed output yet (like EXTERNAL_ACTION_STARTED, also
    // unmapped); PUBLISH_REFUSED and CHARACTER_REFUSED are runtime gate decisions; and
    // EXTERNAL_ACTION_ACKNOWLEDGED is the owner's decision that a result was checked.
    default:
      return null;
  }
}
