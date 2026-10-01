import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { DockerSandbox } from '../src/kernel/docker-sandbox.js';
import { WorkRuntime, type WorkRuntimeOptions } from '../src/daemon/work-runtime.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { ChatService } from '../src/daemon/chat.js';
import { findWorkContract, CustomContractSchema, DIRECT_WORK_CONTRACTS, ROUTINE_ASK_CONTRACT, CONVERSATION_CONTRACT } from '../src/daemon/work-contract.js';
import { ApprovalGate } from '../src/daemon/control-plane.js';
import { McpRegistry } from '../src/daemon/mcp-registry.js';
import { DaemonWsServer } from '../src/daemon/ws-server.js';
import type { ILLMClient, LLMRequest } from '../src/evals/llm-client.js';
import { ProviderCallError } from '../src/evals/llm-client.js';

const MODEL = 'claude-haiku-4-5';
const contract = findWorkContract('cli-arg-parser')!;
const source = `\nexport function parseArgs(argv) {
  const flags = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, ...rest] = arg.slice(2).split('=');
      flags[key] = rest.length ? rest.join('=') : key === 'verbose' ? true : argv[i+1] && !argv[i+1].startsWith('-') ? argv[++i] : true;
    } else if (arg === '-v') flags.v = true;
    else positional.push(arg);
  }
  return { flags, positional };
}\n\n`;
const write = (content = source) => ({ tool: 'write', path: 'src/index.js', content });

test('custom repository snapshot repairs existing source while original acceptance tests remain authoritative', { timeout: 90000 }, async () => {
  const sandbox = new DockerSandbox();
  const custom = CustomContractSchema.parse({ id: 'custom-total', name: 'Repair invoice total', description: 'Repair numeric totals in a supplied snapshot.', requirements: ['The supplied checks pass.'],
    initialFiles: { 'package.json': '{"type":"module"}', 'src/total.js': 'export const total = () => 0;', 'test.mjs': "import assert from 'node:assert/strict'; import {total} from './src/total.js'; assert.equal(total([2,3]),5); assert.equal(total([]),0);" }, writableFiles: ['src/total.js'], testCommand: 'node test.mjs' });
  const h = harness([{ tool: 'write', path: 'src/total.js', content: 'export const total = () => 0;' },
    { tool: 'run', command: "printf 'process.exit(0)' > test.mjs" }, { tool: 'verify' },
    { tool: 'write', path: 'src/total.js', content: 'export const total = values => values.reduce((a,b)=>a+b,0);' }, { tool: 'verify' }, { tool: 'finish' }], sandbox);
  const run = h.store.createTaskRun({ agentId: 'worker', taskName: custom.id }); h.store.startTaskRun(run.id, MODEL);
  try {
    const result = await h.runtime.execute({ taskRunId: run.id, contract: custom, request: 'Fix this snapshot.', signal: new AbortController().signal });
    h.store.finishTaskRun(run.id, result.outcome);
    assert.equal(result.outcome, 'COMPLETED');
    assert.deepEqual(h.store.getTaskEvents(run.id).filter(e=>e.event_type==='WORK_VERIFIED').map(e=>JSON.parse(e.payload_json!).passed),[false,true]);
    const tests=result.artifacts.find(a=>a.path==='test.mjs')!;
    assert.equal(h.artifacts.read(run.id,tests.id)?.content,custom.initialFiles['test.mjs']);
  } finally { await sandbox.destroyWorkspaceVolume(sandbox.workspaceVolumeName(`task-${run.id}`)); h.close(); }
});

class ScriptedLLM implements ILLMClient {
  requests: LLMRequest[] = [];
  constructor(private actions: unknown[]) {}
  async generateCode(request: LLMRequest) {
    this.requests.push({ ...request, messages: request.messages?.map(m => ({ ...m })) });
    const action = this.actions.shift() ?? { tool: 'block', reason: 'Fixture has no further actions.' };
    return { content: typeof action === 'string' ? action : JSON.stringify(action), inputTokens: 100, outputTokens: 100, attemptCount: 1 };
  }
}

// Only control-flow tests use this double. Isolation and file fidelity are tested against real Docker below.
type Sandbox = WorkRuntimeOptions['sandbox'];
class MemorySandbox implements Sandbox {
  files = new Map<string, Record<string, string>>();
  calls: string[] = [];
  async createWorkspaceVolume(id: string) { this.files.set(id, {}); return id; }
  async stageWorkspaceFiles(id: string, files: Record<string, string>) { Object.assign(this.files.get(id)!, files); }
  async readWorkspaceFile(id: string, file: string) { if (!(file in this.files.get(id)!)) throw new Error('Missing file'); return { content: this.files.get(id)![file], truncated: false }; }
  async executeTask(id: string, command: string) { this.calls.push(command); return { exitCode: this.files.get(id)!['src/index.js'] === source ? 0 : 1, stdout: 'Fixture checks', stderr: '', durationMs: 1, timedOut: false }; }
  async destroyWorkspaceVolume(id: string) { this.files.delete(id); }
}

function harness(actions: unknown[], sandbox: WorkRuntimeOptions['sandbox'] = new MemorySandbox(), dbPath = ':memory:') {
  const store = new AgentStore(dbPath);
  const ledger = new CostLedger(store.getDatabase());
  store.createAgent({ id: 'worker', name: 'Worker', model_id: MODEL, budget_cap_usd: 100, current_status: 'IDLE' });
  const llm = new ScriptedLLM(actions);
  const artifacts = new ArtifactStore(store);
  const runtime = new WorkRuntime({ store, ledger, llm, sandbox, artifacts });
  const chat = new ChatService({ agentStore: store, ledger, llmClient: llm, workRuntime: runtime });
  const thread = chat.createThread('worker');
  return { store, ledger, llm, artifacts, runtime, chat, thread, sandbox,
    send: (requestId = 'one') => chat.send(thread.id, 'Implement the selected contract.', requestId, contract.id),
    close: () => { ledger.close(); store.close(); } };
}

test('unusable provider output records billed usage and never executes the partial action', async () => {
  const h = harness([]);
  const llm: ILLMClient = { async generateCode(req) {
    req.onProviderEvent?.({phase:'failed',modelId:req.modelId,attempt:1,elapsedMs:4,code:'OUTPUT_LIMIT'});
    throw new ProviderCallError('OUTPUT_LIMIT','Output token limit reached.',{usage:{inputTokens:80,outputTokens:4096},finishReason:'length'});
  }};
  const runtime = new WorkRuntime({store:h.store,ledger:h.ledger,sandbox:h.sandbox,artifacts:h.artifacts,llm});
  const run=h.store.createTaskRun({agentId:'worker',taskName:'usage-fixture'});h.store.startTaskRun(run.id,MODEL);
  try {
    const result=await runtime.execute({taskRunId:run.id,contract:findWorkContract('action-plan')!,request:'Plan the fixture',signal:new AbortController().signal});
    assert.equal(result.outcome,'FAILED');assert.equal(result.inputTokens,80);assert.equal(result.outputTokens,4096);assert.ok(result.actualCostUsd>0);assert.equal(result.artifacts.length,0);
    assert.equal(h.store.getTaskEvents(run.id).filter(e=>e.event_type==='WORK_ACTION').length,0);
    assert.equal(h.store.getTaskEvents(run.id).filter(e=>e.event_type==='PROVIDER_CALL').length,1);
    assert.equal(h.store.getDatabase().prepare('SELECT status FROM cost_reservations WHERE task_id=?').get(run.id)!.status,'RECONCILED');
  } finally {h.close();}
});

test('a provider answer without usage retains its dispatched budget reservation', async () => {
  const h=harness([]);
  const runtime=new WorkRuntime({store:h.store,ledger:h.ledger,sandbox:h.sandbox,artifacts:h.artifacts,
    llm:{async generateCode(){return {content:JSON.stringify({tool:'block',reason:'Fixture stopped'}),inputTokens:0,outputTokens:0,attemptCount:1,usageKnown:false};}}});
  const run=h.store.createTaskRun({agentId:'worker',taskName:'unknown-usage'});h.store.startTaskRun(run.id,MODEL);
  try {
    await runtime.execute({taskRunId:run.id,contract:findWorkContract('action-plan')!,request:'Plan fixture',signal:new AbortController().signal});
    const row=h.store.getDatabase().prepare('SELECT status,dispatched_at,estimated_cost_usd FROM cost_reservations WHERE task_id=?').get(run.id)!;
    assert.equal(row.status,'PENDING');assert.ok(row.dispatched_at);assert.ok(Number(row.estimated_cost_usd)>0);
    assert.equal(h.store.getTaskEvents(run.id).filter(e=>e.event_type==='PROVIDER_USAGE_UNKNOWN').length,1);
  } finally {h.close();}
});

test('a premature mission wait is corrected before delivery, without overriding the model decision', async () => {
  const plan={title:'Release',tasks:[{id:'report',title:'Write report',doneWhen:'Report saved',priority:1,dependsOn:[]}],limitations:['Synthetic fixture']};
  const h=harness([
    {tool:'write',path:'plan.json',content:JSON.stringify(plan)}, {tool:'verify'},
    {tool:'finish',mission:{state:'wait',reason:'Plan verified; source report not yet created.',nextRequest:'Create the supplied source report',nextContractId:'evidence-brief'}},
    {tool:'finish',mission:{state:'continue',reason:'Plan delivered; supplied evidence permits the report.',nextRequest:'Create the supplied source report',nextContractId:'evidence-brief'}},
  ]);
  const runtime=new WorkRuntime({store:h.store,ledger:h.ledger,llm:h.llm,sandbox:h.sandbox,artifacts:h.artifacts,contracts:DIRECT_WORK_CONTRACTS});
  const run=h.store.createTaskRun({agentId:'worker',taskName:'mission-fixture'});h.store.startTaskRun(run.id,MODEL);
  try {
    const result=await runtime.execute({taskRunId:run.id,contract:findWorkContract('action-plan')!,request:'Plan then report using supplied facts.',mission:true,signal:new AbortController().signal});
    assert.equal(result.outcome,'COMPLETED');assert.equal(result.mission?.state,'continue');assert.equal(result.turns,4);
    const events=h.store.getTaskEvents(run.id);
    assert.equal(events.filter(e=>e.event_type==='MISSION_DECISION_REJECTED').length,1);
    assert.equal(events.filter(e=>e.event_type==='ARTIFACT_CREATED').length,2);
    assert.match(h.llm.requests[3].userPrompt,/Waiting requires blocker/);
    assert.match(result.report,/Mission will continue/);
  } finally {h.close();}
});

test('a concrete missing input keeps a mission waiting and explains how to resume', async () => {
  const h=harness([{tool:'write',path:'plan.json',content:JSON.stringify({title:'Release',tasks:[{id:'check',title:'Review input',priority:1,dependsOn:[],doneWhen:'Input reviewed'}],limitations:['Missing input']})},
    {tool:'verify'},{tool:'finish',mission:{state:'wait',reason:'Review needs the actual source document.',blocker:{kind:'missing_input',detail:'The source document is absent.',resumeWhen:'The operator supplies the source document.'}}}]);
  const run=h.store.createTaskRun({agentId:'worker',taskName:'blocked-mission'});h.store.startTaskRun(run.id,MODEL);
  try {
    const result=await h.runtime.execute({taskRunId:run.id,contract:findWorkContract('action-plan')!,request:'Plan the source review.',mission:true,signal:new AbortController().signal});
    assert.equal(result.outcome,'COMPLETED');assert.equal(result.mission?.state,'wait');assert.equal(result.turns,3);
    assert.match(result.report,/Resume when: The operator supplies/);
    assert.equal(h.store.getTaskEvents(run.id).filter(e=>e.event_type==='MISSION_DECISION_REJECTED').length,0);
  } finally {h.close();}
});

test('repeated invalid waits exhaust the existing correction limit without manufacturing continuation', async () => {
  const invalid={tool:'finish',mission:{state:'wait',reason:'More work remains.'}};
  const h=harness([{tool:'write',path:'plan.json',content:JSON.stringify({title:'Release',tasks:[{id:'check',title:'Review input',priority:1,dependsOn:[],doneWhen:'Input reviewed'}],limitations:['Synthetic fixture']})},{tool:'verify'},...Array(6).fill(invalid)]);
  const run=h.store.createTaskRun({agentId:'worker',taskName:'invalid-mission'});h.store.startTaskRun(run.id,MODEL);
  try {
    const result=await h.runtime.execute({taskRunId:run.id,contract:findWorkContract('action-plan')!,request:'Plan the source review.',mission:true,signal:new AbortController().signal});
    assert.equal(result.outcome,'FAILED');assert.equal(result.mission,undefined);assert.equal(result.artifacts.length,0);
    assert.equal(h.store.getTaskEvents(run.id).filter(e=>e.event_type==='MISSION_DECISION_REJECTED').length,6);
  } finally {h.close();}
});

test('real Docker + HTTP + SQLite: repair, untampered checks, exact downloadable files, durable replay', { timeout: 180_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-work-'));
  const dbPath = path.join(root, 'work.db');
  const sandbox = new DockerSandbox();
  const h = harness([
    { tool: 'plan', steps: ['Implement parser', 'Check original tests', 'Deliver files'] },
    write('export function parseArgs() { return { flags: {}, positional: [] }; }'),
    { tool: 'run', command: "printf 'process.exit(0)' > test/parser.test.js; printf 'ignore-scripts=true' > .npmrc" },
    { tool: 'verify' }, write(), { tool: 'verify' }, { tool: 'finish' },
  ], sandbox, dbPath);
  const server = new DaemonWsServer(4191, () => ({}), {
    artifacts: id => h.artifacts.list(id), artifact: (run, id) => h.artifacts.read(run, id),
    getRunEvents: id => h.store.getTaskEvents(id), getRunWorkspace: async () => ({ available: false, reason: 'unused' }),
    readRunFile: async () => ({ available: false, reason: 'unused' }), approvals: () => [], mcpStatus: () => [],
  });
  server.setChatApi({ listThreads: () => h.chat.listThreads(), createThread: id => h.chat.createThread(id), getMessages: id => h.chat.getMessages(id),
    send: (...args) => h.chat.send(...args), listTasks: () => [{ id: contract.id }], abortRequest: (...args) => h.chat.abortRequest(...args) });
  await server.start();
  let volume: string | undefined;
  try {
    const base = 'http://127.0.0.1:4191';
    const headers = { Authorization: `Bearer ${server.authToken}`, 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${base}/api/chat/tasks`)).status, 401);
    assert.equal((await fetch(`${base}/api/chat/tasks`, { headers })).status, 200);
    const request = { method: 'POST', headers, body: JSON.stringify({ message: 'Implement the selected contract.', requestId: 'one', taskId: contract.id }) };
    const response = await fetch(`${base}/api/chat/threads/${h.thread.id}/messages`, request);
    assert.equal(response.status, 200);
    const result = await response.json() as Awaited<ReturnType<ChatService['send']>>;
    volume = sandbox.workspaceVolumeName(`task-${result.taskRunId}`);
    assert.equal(result.work?.outcome, 'COMPLETED', result.reply?.content);
    const checks = h.store.getTaskEvents(result.taskRunId).filter(e => e.event_type === 'WORK_VERIFIED').map(e => JSON.parse(e.payload_json));
    assert.deepEqual(checks.map(e => e.passed), [false, true], 'modified tests and npm config cannot make wrong source pass');
    assert.match(h.llm.requests[4].messages!.at(-1)!.content, /error/);
    const artifact = result.work!.artifacts.find(a => a.path === 'src/index.js')!;
    assert.equal(h.artifacts.read(result.taskRunId, artifact.id)?.content, source, 'whitespace remains exact');
    assert.equal(h.artifacts.read(result.taskRunId, result.work!.artifacts.find(a => a.path === 'test/parser.test.js')!.id)?.content, contract.initialFiles['test/parser.test.js']);
    assert.ok(!result.work!.artifacts.some(a => a.path === '.npmrc'));
    await sandbox.destroyWorkspaceVolume(volume); volume = undefined;
    const download = await fetch(base + artifact.downloadUrl, { headers });
    assert.equal(await download.text(), source);
    assert.equal(download.headers.get('X-Content-SHA256'), artifact.sha256);
    assert.match(download.headers.get('Content-Disposition')!, /attachment/);
    assert.equal((await fetch(base + artifact.downloadUrl)).status, 401);
    assert.equal((await fetch(`${base}/api/runs/other/artifacts/${artifact.id}`, { headers })).status, 404);
    assert.deepEqual(await (await fetch(`${base}/api/chat/threads/${h.thread.id}/messages`, request)).json(), result);
    assert.equal(h.llm.requests.length, 7, 'retry performs no additional action');
    await assert.rejects(() => h.chat.send(h.thread.id, 'Implement the selected contract.', 'one'), /different task mode/);
    const reopened = new AgentStore(dbPath);
    try {
      assert.equal(new ArtifactStore(reopened).read(result.taskRunId, artifact.id)?.content, source);
      const restarted = new ChatService({ agentStore: reopened, ledger: h.ledger, workRuntime: h.runtime, llmClient: h.llm });
      assert.deepEqual(await restarted.send(h.thread.id, 'Implement the selected contract.', 'one', contract.id), result);
      assert.equal(h.llm.requests.length, 7);
    } finally { reopened.close(); }
  } finally {
    await server.close();
    if (volume) await sandbox.destroyWorkspaceVolume(volume);
    h.close();
    for (const file of fs.readdirSync(root)) fs.unlinkSync(path.join(root, file));
    fs.rmdirSync(root);
  }
});

test('completion is refused before verification and after a later source change', async () => {
  const h = harness([{ tool: 'finish' }, write(), { tool: 'verify' }, write('broken'), { tool: 'finish' }, { tool: 'block', reason: 'Need repair' }]);
  try {
    const result = await h.send();
    assert.equal(result.work?.outcome, 'FAILED');
    assert.equal(h.artifacts.list(result.taskRunId).length, 0);
    const errors = h.store.getTaskEvents(result.taskRunId).filter(e => e.event_type === 'TOOL_CALL' && JSON.parse(e.payload_json).status === 'error');
    assert.equal(errors.length, 2);
    assert.match(result.reply.content, /Need repair/);
  } finally { h.close(); }
});

test('unknown tools, malformed output, protected files and path traversal have no effects', async () => {
  for (const action of ['not json', { tool: 'host.exec', command: 'danger' }, { tool: 'write', path: '../escape.js', content: 'x' }, { tool: 'write', path: 'test/parser.test.js', content: 'x' }]) {
    const sandbox = new MemorySandbox();
    // Every scripted reply fails: a run now gets one turn to change approach before it
    // is abandoned, so six are needed to exhaust it. A valid action here would be reached
    // by that recovery turn and would stop testing what this test is for - that an unknown
    // tool, a traversal path and a protected file never take effect.
    const h = harness([action, action, action, action, action, action], sandbox);
    try {
      const result = await h.send();
      assert.equal(result.work?.outcome, 'FAILED');
      assert.equal(h.llm.requests.length, 6);
      assert.deepEqual([...sandbox.files.values()][0], contract.initialFiles);
      assert.equal(sandbox.calls.length, 0);
    } finally { h.close(); }
  }
});

test('one JSON action inside prose is normalized, while a second object remains non-executable', async () => {
  const wrapped = (action: unknown, prose: string) => `Here is the action:\n\`\`\`json\n${JSON.stringify(action)}\n\`\`\`\n${prose}`;
  const accepted = harness([
    wrapped(write(), 'I replaced the source file.'),
    wrapped({ tool: 'verify' }, 'The fixed checks should run now.'),
    wrapped({ tool: 'finish' }, 'The checked file is ready.'),
  ]);
  try {
    const result = await accepted.send('wrapped');
    assert.equal(result.work?.outcome, 'COMPLETED');
    assert.equal(accepted.store.getTaskEvents(result.taskRunId).filter(event => event.event_type === 'ACTION_ENVELOPE_NORMALIZED').length, 3);
  } finally { accepted.close(); }

  const ambiguous = `${JSON.stringify(write())}\n${JSON.stringify({ note: 'a second JSON object' })}`;
  const refused = harness([ambiguous, ambiguous, ambiguous, ambiguous, ambiguous, ambiguous]);
  try {
    const result = await refused.send('ambiguous');
    assert.equal(result.work?.outcome, 'FAILED');
    assert.equal(refused.store.getTaskEvents(result.taskRunId).filter(event => event.event_type === 'WORK_ACTION').length, 0);
    assert.deepEqual([...(refused.sandbox as MemorySandbox).files.values()][0], contract.initialFiles);
  } finally { refused.close(); }
});

test('turn and budget limits stop dispatch; failed work is replayed rather than retried', async () => {
  const h = harness(Array.from({ length: 30 }, (_, i) => ({ tool: 'plan', steps: [`Still planning ${i}`] })));
  try {
    const result = await h.send();
    assert.equal(h.llm.requests.length, 24);
    assert.match(result.reply.content, /turn limit/);
    assert.deepEqual(await h.send(), result);
    assert.equal(h.llm.requests.length, 24);
    h.store.updateAgent('worker', { budget_cap_usd: 0 });
    const capped = await h.send('two');
    assert.equal(capped.work?.outcome, 'FAILED');
    assert.equal(h.llm.requests.length, 24);
  } finally { h.close(); }
});

test('real Docker: cancel interrupts an active command and prevents later actions', { timeout: 90_000 }, async () => {
  const sandbox = new DockerSandbox();
  const h = harness([{ tool: 'run', command: 'sleep 60' }, write()], sandbox);
  const send = h.send();
  let runId: string | undefined;
  try {
    for (let i = 0; i < 500; i++) {
      runId = h.store.listTaskRuns()[0]?.id;
      if (runId && h.store.getTaskEvents(runId).some(e => e.event_type === 'WORK_ACTION')) break;
      await delay(20);
    }
    assert.ok(runId);
    await delay(1500); // allow Docker to enter the command, rather than cancelling only the model boundary
    assert.equal(h.chat.abortRequest(h.thread.id, 'one'), true);
    const result = await send;
    assert.equal(result.work?.outcome, 'ABORTED');
    assert.equal(h.store.getTaskRun(result.taskRunId)?.status, 'ABORTED');
    assert.equal(h.llm.requests.length, 1);
    assert.equal(h.chat.abortRequest(h.thread.id, 'one'), false);
    assert.equal(h.artifacts.list(result.taskRunId).length, 0);
  } finally {
    await h.chat.stop();
    if (runId) await sandbox.destroyWorkspaceVolume(sandbox.workspaceVolumeName(`task-${runId}`));
    h.close();
  }
});

test('real MCP: approved calls execute; denial and cancellation never contact the tool', { timeout: 30_000 }, async () => {
  for (const decision of ['APPROVED', 'DENIED', 'CANCEL'] as const) {
    const h = harness([{ tool: 'mcp', server: 'echo', name: 'reverse', args: { text: 'abc' } }, { tool: 'block', reason: 'Fixture done' }]);
    const mcp = new McpRegistry({ agentStore: h.store, servers: [{ name: 'echo', command: process.execPath, args: [path.resolve('tests/fixtures/echo-mcp-server.mjs')] }], allowlist: { worker: ['echo'] } });
    const approvals = new ApprovalGate(h.store);
    await mcp.start();
    const runtime = new WorkRuntime({ store: h.store, ledger: h.ledger, llm: h.llm, sandbox: h.sandbox, artifacts: h.artifacts, mcp, approvals });
    const chat = new ChatService({ agentStore: h.store, ledger: h.ledger, llmClient: h.llm, workRuntime: runtime });
    const send = chat.send(h.thread.id, 'Test approved fixture tool.', 'mcp', contract.id);
    try {
      let row;
      for (let i = 0; i < 200; i++) { row = h.store.listApprovals()[0]; if (row && approvals.isWaiting(row.id)) break; await delay(10); }
      assert.ok(row);
      assert.equal(JSON.parse(row.payload_json).args.text, 'abc');
      assert.equal(mcp.status()[0].callsUsed, 0, 'no call before approval');
      if (decision === 'CANCEL') chat.abortRequest(h.thread.id, 'mcp');
      else approvals.decide(row.id, decision);
      const result = await send;
      const calls = h.store.getTaskEvents(result.taskRunId).filter(e => e.event_type === 'TOOL_CALL' && JSON.parse(e.payload_json).transport === 'mcp');
      assert.equal(calls.length, decision === 'APPROVED' ? 1 : 0);
      if (decision === 'APPROVED') assert.match(h.llm.requests[1].messages!.at(-1)!.content, /cba/);
    } finally { await chat.stop(); await mcp.stop(); h.close(); }
  }
});

test('artifact limits are atomic and agent deletion removes saved files', () => {
  const h = harness([]);
  try {
    const run = h.store.createTaskRun({ agentId: 'worker', taskName: 'artifact-test' });
    h.store.startTaskRun(run.id, MODEL);
    assert.throws(() => h.artifacts.save(run.id, { '../bad': 'x' }), /relative workspace/);
    assert.throws(() => h.artifacts.save(run.id, { 'good.txt': 'x', 'huge.txt': 'x'.repeat(262145) }), /256 KiB/);
    assert.equal(h.artifacts.list(run.id).length, 0);
    const saved = h.artifacts.save(run.id, { 'ok.txt': 'exact\n' });
    assert.throws(() => h.artifacts.save(run.id, { 'second.txt': 'x', 'ok.txt': 'collision' }));
    assert.equal(h.artifacts.list(run.id).length, 1, 'a partial insert rolled back');
    h.store.finishTaskRun(run.id, 'COMPLETED');
    h.store.deleteAgent('worker');
    assert.equal(h.artifacts.read(run.id, saved[0].id), null);
  } finally { h.close(); }
});

test('direct concurrency shares admission and cancellation releases slots', async () => {
  const h = harness([]);
  h.llm.generateCode = async request => {
    await new Promise<void>((_resolve, reject) => {
      request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true });
      request.signal!.throwIfAborted();
    });
    throw new Error('unreachable');
  };
  const threads = [h.thread, h.chat.createThread('worker'), h.chat.createThread('worker')];
  const active = threads.slice(0, 2).map(t => h.chat.send(t.id, 'wait', 'one', contract.id));
  try {
    for (let i = 0; i < 100 && h.store.listTaskRuns().length < 2; i++) await delay(5);
    await assert.rejects(h.chat.send(threads[2].id, 'wait', 'one', contract.id), /concurrency limit/);
    threads.slice(0, 2).forEach(t => h.chat.abortRequest(t.id, 'one'));
    assert.deepEqual((await Promise.all(active)).map(r => r.work?.outcome), ['ABORTED', 'ABORTED']);
    h.llm.generateCode = async () => ({ content: '{"tool":"block","reason":"slot released"}', inputTokens: 10, outputTokens: 10, attemptCount: 1 });
    const next = await h.chat.send(threads[2].id, 'continue', 'two', contract.id);
    assert.match(next.work!.report, /slot released/);
  } finally { await h.chat.stop(); await Promise.allSettled(active); h.close(); }
});

test('flexible routine deliverables can write html and custom files and publish them', async () => {
  const h = harness([
    { tool: 'write', path: 'report.html', content: '<html><body><h1>AI Report</h1></body></html>' },
    { tool: 'write', path: 'data.json', content: '{"items":[1,2,3]}' },
    { tool: 'verify' },
    { tool: 'finish' },
  ]);
  const run = h.store.createTaskRun({ agentId: 'worker', taskName: 'routine-ask' });
  h.store.startTaskRun(run.id, MODEL);
  try {
    const result = await h.runtime.execute({
      taskRunId: run.id,
      contract: ROUTINE_ASK_CONTRACT,
      request: 'Generate an HTML report and data file.',
      scheduled: { routineId: 'routine-1' },
      conversation: true,
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, 'COMPLETED');
    assert.equal(result.artifacts.length, 2);
    const htmlArtifact = result.artifacts.find(a => a.path === 'report.html')!;
    assert.ok(htmlArtifact);
    assert.equal(h.artifacts.read(run.id, htmlArtifact.id)?.content, '<html><body><h1>AI Report</h1></body></html>');
    const dataArtifact = result.artifacts.find(a => a.path === 'data.json')!;
    assert.ok(dataArtifact);
    assert.equal(h.artifacts.read(run.id, dataArtifact.id)?.content, '{"items":[1,2,3]}');
  } finally { h.close(); }
});

test('flexible conversational answer saves written deliverables as artifacts', async () => {
  const h = harness([
    { tool: 'write', path: 'summary.html', content: '<p>Summary</p>' },
    { tool: 'answer', text: 'Here is your summary in summary.html', citations: [] },
  ]);
  const run = h.store.createTaskRun({ agentId: 'worker', taskName: 'conversation' });
  h.store.startTaskRun(run.id, MODEL);
  try {
    const result = await h.runtime.execute({
      taskRunId: run.id,
      contract: ROUTINE_ASK_CONTRACT,
      request: 'Summarize and write summary.html.',
      conversation: true,
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, 'COMPLETED');
    assert.match(result.report, /Here is your summary in summary.html/);
    const htmlArtifact = result.artifacts.find(a => a.path === 'summary.html')!;
    assert.ok(htmlArtifact);
    assert.equal(h.artifacts.read(run.id, htmlArtifact.id)?.content, '<p>Summary</p>');
    const answerArtifact = result.artifacts.find(a => a.path === 'answer.md')!;
    assert.ok(answerArtifact);
  } finally { h.close(); }
});

test('auto-finalizes verified deliverables when turn limit is reached', async () => {
  const h = harness([
    { tool: 'write', path: 'report.html', content: '<h1>Final Report</h1>' },
    { tool: 'verify' },
  ]);
  const run = h.store.createTaskRun({ agentId: 'worker', taskName: 'conversation' });
  h.store.startTaskRun(run.id, MODEL);
  try {
    const result = await h.runtime.execute({
      taskRunId: run.id,
      contract: { ...CONVERSATION_CONTRACT, maxTurns: 2 },
      request: 'Write and verify report.html.',
      conversation: true,
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, 'COMPLETED');
    assert.equal(result.artifacts.length, 1);
    const htmlArtifact = result.artifacts.find(a => a.path === 'report.html')!;
    assert.ok(htmlArtifact);
    assert.equal(h.artifacts.read(run.id, htmlArtifact.id)?.content, '<h1>Final Report</h1>');
  } finally { h.close(); }
});

