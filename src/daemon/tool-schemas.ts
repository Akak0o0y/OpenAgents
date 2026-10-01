import { actionSchema } from './work-actions.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodObject, ZodRawShape } from 'zod';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const TOOL_DESCRIPTIONS: Record<string, string> = {
  send_message:'Send exact text in an already selected and observed WhatsApp Web chat, tied to a declared result and unambiguous international phone number. Checks outgoing send/delivery evidence; uncertain sends must not be repeated. Resolve myself through observed authenticated identity or ask for the missing number. Optional attachmentPath sends one verified text/HTML report from this run; declare acceptance.attachmentPaths, verify the file and open the document attachment menu first. Attachment verification downloads the exact outgoing document and compares its bytes; unavailable markup or receipt stays unverified.',
  declare_results:'Before external actions, record a visible checklist covering every result the owner requested. Preserve exact destination/recipient; ask for missing identity instead of guessing. This can be called once, cannot amend existing requirements, and does not verify anything. Use artifact/1 for saved files, whatsapp/1 for message receipts, publish/1 for publications; other verifiers remain unconfigured.',
  reconcile_message:'Read-only receipt check for an unresolved WhatsApp attempt, in the already selected original chat. Never resends. Use result_status to find unresolved attempt IDs.',
  result_status:'Read the current result checklist and independently check retained artifacts. Unverified or uncertain delivery must never be reported as completed. Do not repeat uncertain submissions.',
  propose_character: 'Draft this bot’s character for owner approval. Start returns a guide; propose creates five unsent previews and an approval card. Never activates changes itself.',
  prepare_post: "Write a public post or reply in this bot's character. Returns the exact text to type and an approval that expires. Type it exactly, then click Post. In routine runs, posts not written this way are refused.",
  background_start:'Queue a scoped independent background task. It uses the scheduler capacity and your budget, retains text work and can be continued after it ends. Does not block this conversation.',
  background_status:'List your saved background tasks and their current run statuses.',
  background_continue:'Continue one ended background task with a new instruction and retained context/files. Never repeats an uncertain external action without operator acknowledgement.',
  delete_file: 'Delete one repository file. The deletion is included in verification and the reviewed publication manifest.',
  rename_file: 'Move one repository file to a new unused path. Both paths enter the verified change manifest.',
  register_file: 'Register a file produced by a sandbox command for delivery, including binary assets. Limited to 2 MiB per file.',
  ask_user_question: 'Save a question for the operator and pause this task. An answer queues a new attempt with retained files and context. Do not request passwords or API keys.',
  create_document: 'Create Office output with standard/executive/academic templates. DOCX: paragraphs, sections and table. XLSX: rows with scalar values or {formula}, plus bar/line/pie charts. Numeric formulas support arithmetic, cells, ranges and SUM/AVERAGE/MIN/MAX/COUNT. PPTX: slides with bullets, rightBullets, chart or table. Outputs are structurally checked and delivered on answer/finish.',
  browser: 'Interact with web pages using the bot\'s managed browser. First use action="snapshot". For fill, click, press, hover, select, check, drag, download, or upload, supply a nested target from that fresh snapshot: {"action":"fill","target":{"ref":"e4"},"value":"text"}, or target={"role":"textbox","name":"Search"}. These are syntax examples, not observed targets. Never omit target, guess a ref, or put role/name at the top level. Drag also requires destination. Press sends a key to the selected element; use computer for screenshot-grounded desktop shortcuts. After a target error, correct the arguments rather than repeating the same targetless action.',
  computer: "See and control the bot's own Linux desktop using screenshots and native mouse/keyboard input. Screenshot first; use its pixel coordinates. Never controls the personal host desktop.",
  desktop_run: "Run a shell command on the bot's own Linux computer - the same machine its desktop and Chrome run on. This is not the operator's computer and not the coding container: it cannot see either. Returns the real exit status with stdout and stderr; a non-zero status is a genuine failure, not a signal to retry. Prefer this over clicking through windows for file and system work. python3, pip and npm are installed, so missing tooling can be added with `pip install --user NAME` or `npm install -g NAME`; check with `command -v NAME` before assuming a program exists.",
  desktop_files: "List, read, write, move or remove files on the bot's own Linux computer, anywhere under its home directory. Use this instead of typing into an editor window. These are not the operator's files and not the coding container's workspace.",
  desktop_jobs: "Start work that outlives one step and come back to it: a server, a long download, a render, anything that keeps running while you do something else. {operation:start,command:...} returns a jobId immediately instead of waiting. {operation:list} shows what is running, {operation:output,jobId} reads what it has printed so far, {operation:stop,jobId} ends it and everything it started. Use desktop_run for commands that finish on their own; use this when waiting would block you.",
  desktop_record: "Record the bot's own screen while it works, then attach the result to a page. {operation:start} begins recording its Linux desktop, {operation:stop} finishes and returns the file under Videos/, and {operation:status} reports whether one is running. Upload the result with browser upload and desktopPath. This records the bot's own desktop only, never the operator's computer.",
  desktop_read_screen: "Read the text that is actually on your screen instead of guessing at it from the image. Give x, y, width and height to read one region - a button, a field, a code, an amount - which is where this is far more reliable than looking. Reading the whole screen returns noise. Handles English and Arabic.",
  desktop_display: "Get or change the size of the bot's own screen. {operation:get} reports it; {operation:set,width,height} resizes it, which is how to see what a page looks like at another width. Both dimensions must be even.",
  desktop_open: "Open a file, folder or URL on the bot's own Linux computer with its default application, or launch one of its installed applications: files, terminal, editor, images, archives, chrome.",
  mission_items: 'Inspect durable tracked issue items for the current mission run.',
  track_issue: 'Record an issue tracked from captured web or browser sources.',
  start_mission: 'Propose starting a durable bounded background mission toward an objective for operator approval.',
  create_routine: 'Propose creating a recurring scheduled routine for operator approval.',
  connect_obsidian_vault: 'Propose connecting an Obsidian vault folder for operator approval.',
  request_account: 'Propose requesting a website account login from the operator via a secure form.',
  vault_list: 'List Markdown notes in the connected Obsidian vault.',
  vault_import: 'Import a note from the connected Obsidian vault into bot memory.',
  vault_export: 'Export a bot memory note as a new file in the connected Obsidian vault.',
  start_repository_work: 'Propose pinned repository work for operator approval. Use owner/repo or local/alias. Select paths (file/directory prefixes) for large repositories. workingTree=true includes uncommitted and untracked non-ignored local files, captured once for approval. Private repositories require configured credentials.',
  web_read: 'Fetch and read the text content of a web page.',
  web_search: 'Search the web for current information, articles, and sources.',
  github_issues: 'Search public GitHub issues and pull requests.',
  answer: 'Provide a direct conversational answer with optional citations.',
  plan: 'Propose a short public plan with sequential steps.',
  todo_write: 'Set or update the task checklist (up to 20 items, at most one in_progress).',
  read: 'Read a text file from the task workspace, with line numbers and optional offset and limit.',
  edit: 'Make a surgical text replacement in a workspace file.',
  list: 'List files and directories in the workspace up to a given depth.',
  glob: 'Find files in the workspace matching a glob pattern.',
  grep: 'Search workspace files for a text pattern or regular expression.',
  diff: 'Show the uncommitted git diff of changes made in the workspace.',
  source: 'Reread captured evidence or request source material by its source ID.',
  write: 'Write complete content to a file in the workspace.',
  run: 'Run a shell command inside the isolated offline container.',
  verify: 'Run the contract verification checks in a fresh container.',
  mcp: 'Call a tool on a permitted Model Context Protocol (MCP) server.',
  finish: 'Complete the task contract with verified deliverables and optional mission decision.',
  remember: 'Store an untrusted note in bot memory.',
  recall: 'Search relevant notes from bot memory.',
  compact: 'Request context compaction to retain vital context.',
  skill: 'Load a skill by its exact name from the workspace catalogue. Skill instructions do not grant additional tool permissions.',
  delegate: 'Delegate a scoped sub-task to a specialized sub-agent or another bot. The sub-agent executes in an isolated context and returns its report upon completion.',
  request_human: "Ask the operator to do one specific thing you cannot do yourself - enter a 2FA code, clear a CAPTCHA, confirm a payment - then continue the same task. State exactly what to do in `what` and why it needs a person in `why`. The operator acts on your own desktop and tells you when it is done, and you carry on from there. Use this instead of giving up; use `block` only when no person could resolve it either.",
  block: 'Declare that the task is blocked with a specific reason and blocker details.',
};

export function buildToolDefinitions(): Map<string, ToolDefinition> {
  const definitions = new Map<string, ToolDefinition>();
  for (const option of actionSchema.options) {
    const zodObj = option as ZodObject<ZodRawShape>;
    const name = String((zodObj.shape.tool as any)?.value ?? '');
    if (!name) continue;
    const omitted = zodObj.omit({ tool: true }).strict();
    const rawSchema = zodToJsonSchema(omitted, { $refStrategy: 'none' }) as Record<string, unknown>;
    delete rawSchema.$schema;
    definitions.set(name, {
      name,
      description: TOOL_DESCRIPTIONS[name] ?? `Execute the ${name} action.`,
      parameters: rawSchema,
    });
  }
  return definitions;
}

const ALL_TOOL_DEFINITIONS = buildToolDefinitions();

export interface ToolAvailabilityContext {
  isConversation?: boolean;
  isScheduled?: boolean;
  isMission?: boolean;
  webEnabled?: boolean;
  browserEnabled?: boolean;
  canPreparePost?: boolean;
  canProposeCharacter?: boolean;
  computerEnabled?: boolean;
  /** The bot desktop is running. Unlike computerEnabled this needs no vision model:
   * a shell and file operations return text, not screenshots. */
  desktopEnabled?: boolean;
  hasMcpTools?: boolean;
  vaultConfigured?: boolean;
  canProposeRoutine?: boolean;
  canProposeVault?: boolean;
  canProposeAccount?: boolean;
  /** The operator can be asked to do one step the bot cannot do itself. Unlike the
   * propose flags this is not conversation-only: a scheduled run that meets a 2FA
   * prompt should be able to wait for a person rather than die. */
  canRequestHuman?: boolean;
  canProposeRepoWork?: boolean;
  hasRepositories?: boolean;
  hasMissions?: boolean;
  isRepoContract?: boolean;
  canDelegate?: boolean;
  hasSkills?: boolean;
  canAskQuestion?: boolean;
  canCreateDocuments?: boolean;
  hasBackground?: boolean;
  /** The executor only runs a shell for code contracts; never offer one elsewhere. */
  shellEnabled?: boolean;
}

export function availableTools(ctx: ToolAvailabilityContext): ToolDefinition[] {
  const allowed = new Set<string>([
    'declare_results','result_status',
    'plan',
    'todo_write',
    'read',
    'edit',
    'list',
    'glob',
    'grep',
    'diff',
    'write',
    'verify',
    'finish',
    'block',
    'remember',
    'recall',
    'compact',
    'delegate',
    'source',
  ]);

  if (ctx.canDelegate === false) {
    allowed.delete('delegate');
  }
  // The executor rejects run outside code contracts, so it is offered only where it works.
  if (ctx.shellEnabled) allowed.add('run');
  if (ctx.hasSkills) allowed.add('skill');
  if (ctx.isRepoContract) for (const name of ['delete_file','rename_file','register_file']) allowed.add(name);
  if (ctx.canAskQuestion) allowed.add('ask_user_question');
  if (ctx.canCreateDocuments) allowed.add('create_document');
  if (ctx.hasBackground && ctx.canDelegate!==false && !ctx.isScheduled && !ctx.isMission) for(const name of ['background_start','background_status','background_continue'])allowed.add(name);

  if (ctx.webEnabled) {
    allowed.add('web_read');
    allowed.add('web_search');
    allowed.add('github_issues');
  }
  if (ctx.canPreparePost) allowed.add('prepare_post');
  if (ctx.canProposeCharacter) allowed.add('propose_character');

  if (ctx.browserEnabled) {
    allowed.add('send_message');
    allowed.add('reconcile_message');
    allowed.add('browser');
    if (ctx.isConversation && !ctx.isScheduled && ctx.canProposeAccount) {
      allowed.add('request_account');
    }
  }
  if (ctx.canRequestHuman) allowed.add('request_human');
  if (ctx.computerEnabled) allowed.add('computer');
  // A shell, file access and app launching need the desktop running, not a vision model.
  if (ctx.desktopEnabled) { allowed.add('desktop_run'); allowed.add('desktop_files'); allowed.add('desktop_open'); allowed.add('desktop_record'); allowed.add('desktop_jobs'); allowed.add('desktop_display'); allowed.add('desktop_read_screen'); }

  if (ctx.hasMcpTools) {
    allowed.add('mcp');
  }

  if (ctx.isConversation) {
    allowed.add('answer');
    if (!ctx.isScheduled) {
      if (ctx.canProposeRoutine) allowed.add('create_routine');
      if (ctx.hasMissions) allowed.add('start_mission');
      if (ctx.canProposeVault && !ctx.vaultConfigured) allowed.add('connect_obsidian_vault');
      if (ctx.hasRepositories && ctx.canProposeRepoWork) allowed.add('start_repository_work');
    }
  }

  if (ctx.vaultConfigured) {
    allowed.add('vault_list');
    allowed.add('vault_import');
    allowed.add('vault_export');
  }

  if (ctx.isMission && ctx.hasMissions) {
    allowed.add('mission_items');
    allowed.add('track_issue');
    if (ctx.hasRepositories && ctx.canProposeRepoWork && !ctx.isRepoContract) {
      allowed.add('start_repository_work');
    }
  }

  const result: ToolDefinition[] = [];
  for (const name of allowed) {
    const def = ALL_TOOL_DEFINITIONS.get(name);
    if (def) result.push(def);
  }
  return result;
}
