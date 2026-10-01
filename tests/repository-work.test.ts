/**
 * Repository work: a pinned public-repository snapshot is changed in an isolated workspace, verified with the
 * project's own test command in a fresh workspace, and delivered as the changed files plus a reviewable patch.
 * Nothing is published. The sandbox and repository fetcher are in-memory fixtures; no Docker or network is used.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { WorkRuntime } from '../src/daemon/work-runtime.js';
import { ChatService } from '../src/daemon/chat.js';
import { DIRECT_WORK_CONTRACTS, repositoryWorkContract, type WorkContract } from '../src/daemon/work-contract.js';
import { systemApi } from '../src/daemon/system-api.js';
import { MissionService } from '../src/daemon/missions.js';
import { saveWorkResult } from '../src/daemon/work-results.js';
import type { RepositoryRef, RepositorySnapshot } from '../src/daemon/repository-snapshot.js';
import type { LLMRequest } from '../src/evals/llm-client.js';

const MODEL = 'claude-haiku-4-5';
const COMMIT = 'c'.repeat(40);
const BROKEN = 'export function add(a, b) {\n  return a - b;\n}\n';
const FIXED = 'export function add(a, b) {\n  return a + b;\n}\n';
const FILES: Record<string, string> = {
  'package.json': '{"name":"calc","scripts":{"test":"node --test"}}\n',
  'src/math.js': BROKEN,
  'test/math.test.js': "import { add } from '../src/math.js';\n",
  'README.md': '# calc\n',
};

class MemorySandbox {
  volumes = new Map<string, Map<string, string>>();
  installs: Array<{ volume: string; manager: string; ignoreScripts?: boolean }> = [];
  commands: Array<{ volume: string; command: string }> = [];
  private next = 0;
  async createWorkspaceVolume(id: string) { const name = `${id}-${this.next++}`; this.volumes.set(name, new Map()); return name; }
  async stageWorkspaceFiles(volume: string, files: Record<string, string>) {
    const target = this.volumes.get(volume);
    assert.ok(target, `volume ${volume} exists`);
    for (const [path, content] of Object.entries(files)) target.set(path, content);
  }
  async readWorkspaceFile(volume: string, path: string, maxBytes = 256 * 1024) {
    const content = this.volumes.get(volume)?.get(path);
    if (content === undefined) throw new Error(`No such file: ${path}`);
    return { content: content.slice(0, maxBytes), truncated: content.length > maxBytes };
  }
  async installDependencies(volume: string, manager: string, options: { ignoreScripts?: boolean } = {}) {
    this.installs.push({ volume, manager, ignoreScripts: options.ignoreScripts });
    this.volumes.get(volume)!.set('node_modules/.installed', 'yes');
    return { exitCode: 0, stdout: 'installed', stderr: '', durationMs: 1, timedOut: false };
  }
  async executeTask(volume: string, command: string) {
    this.commands.push({ volume, command });
    const files = this.volumes.get(volume)!;
    if (command === 'npm test') {
      const pass = !!files.get('src/math.js')?.includes('return a + b') && files.has('node_modules/.installed');
      return { exitCode: pass ? 0 : 1, stdout: pass ? 'ok 1 - add(2, 3) === 5' : 'not ok 1 - expected 5, received -1', stderr: '', durationMs: 1, timedOut: false };
    }
    return { exitCode: 0, stdout: [...files.keys()].sort().join('\n'), stderr: '', durationMs: 1, timedOut: false };
  }
  async destroyWorkspaceVolume(volume: string) { this.volumes.delete(volume); }
}

function fetcher(commit: string | null = COMMIT, files: Record<string, string> = FILES) {
  const requests: RepositoryRef[] = [];
  return {
    requests,
    snapshot: async (repository: RepositoryRef): Promise<RepositorySnapshot> => {
      requests.push(repository);
      return { repository, source: `https://codeload.github.com/${repository.owner}/${repository.repo}/tar.gz/${repository.ref}`, archiveSha256: 'f'.repeat(64), commit,
        fetchedAt: new Date().toISOString(), files: { ...files }, skipped: [{ path: 'logo.png', reason: 'binary' }], textBytes: 200 };
    },
  };
}

const defaultContract = () => repositoryWorkContract({ owner: 'example', repo: 'calc', ref: 'main', commit: COMMIT }, 'npm test', 'auto', 'Fix add() so add(2, 3) returns 5.');

function scripted(steps: unknown[]) {
  const requests: LLMRequest[] = [];
  const llm = { async generateCode(req: LLMRequest) {
    requests.push({ ...req, messages: structuredClone(req.messages) });
    const step = steps.shift();
    assert.ok(step !== undefined, 'no extra model call is scripted');
    return { content: JSON.stringify(step), inputTokens: 10, outputTokens: 10, attemptCount: 1 };
  } };
  return { llm, requests };
}

function harness(steps: unknown[], options: { repositories?: ReturnType<typeof fetcher> | null } = {}) {
  const store = new AgentStore(':memory:');
  const ledger = new CostLedger(store.getDatabase());
  store.createAgent({ id: 'alpha', name: 'Alpha', model_id: MODEL, budget_cap_usd: 10, current_status: 'IDLE' });
  const sandbox = new MemorySandbox();
  const artifacts = new ArtifactStore(store);
  const { llm, requests } = scripted(steps);
  const repositories = options.repositories === null ? undefined : options.repositories ?? fetcher();
  const runtime = new WorkRuntime({ store, ledger, llm, sandbox: sandbox as never, artifacts, repositories });
  const events: Array<{ type: string; payload: any }> = [];
  store.setEventSink(event => events.push({ type: event.event_type, payload: JSON.parse(event.payload_json) }));
  const execute = async (contract = defaultContract()) => {
    const run = store.createTaskRun({ agentId: 'alpha', taskName: `work:${contract.id}` });
    store.startTaskRun(run.id, MODEL);
    const result = await runtime.execute({ taskRunId: run.id, contract, request: 'Fix add() so add(2, 3) returns 5.', signal: new AbortController().signal });
    const read = (path: string) => artifacts.read(run.id, result.artifacts.find(artifact => artifact.path === path)!.id)!.content;
    return { result, runId: run.id, read };
  };
  return { store, sandbox, requests, events, repositories, execute, close: () => { ledger.close(); store.close(); } };
}

test('repository instructions are presented before mutation and skills load from the pinned snapshot', async () => {
  const repositories = fetcher(COMMIT, { ...FILES,
    'AGENTS.md': 'Use the existing test command.',
    'src/AGENTS.md': 'SCOPED_RULE: preserve the public add API.',
    '.agents/skills/math-review/SKILL.md': '---\nname: math-review\ndescription: Review arithmetic changes.\n---\nSKILL_BODY: Check negative operands too.',
  });
  const h = harness([
    { tool: 'skill', name: 'math-review' },
    { tool: 'write', path: 'src/math.js', content: 'SHOULD_NOT_BE_WRITTEN' },
    { tool: 'write', path: 'src/math.js', content: FIXED },
    { tool: 'verify' },
    { tool: 'finish' },
  ], { repositories });
  try {
    const { result, read } = await h.execute();
    assert.equal(result.outcome, 'COMPLETED');
    assert.equal(read('src/math.js'), FIXED);
    assert.ok(h.requests[0].messages![0].content.includes('Use the existing test command.'));
    assert.ok(h.requests[0].messages![0].content.includes('math-review'));
    assert.ok(h.requests[0].tools?.some(tool => tool.name === 'skill'));
    assert.ok(!h.requests[0].messages![0].content.includes('SKILL_BODY'));
    assert.ok(h.requests[1].messages!.some(m => m.content.includes('SKILL_BODY')));
    assert.ok(h.requests[2].messages![0].content.includes('SCOPED_RULE'));
    const guarded = h.events.find(e => e.type === 'TOOL_CALL' && e.payload.notRun);
    assert.ok(guarded?.payload.summary.includes('before changing'));
    assert.equal(h.events.filter(e => e.type === 'WORKSPACE_SKILL_LOADED').length, 1);
    assert.equal(h.events.filter(e => e.type === 'WORKSPACE_INSTRUCTIONS_LOADED').length, 2);
  } finally { h.close(); }
});

function chatHarness(steps: unknown[], decision: 'APPROVED' | 'DENIED') {
  const store = new AgentStore(':memory:');
  const ledger = new CostLedger(store.getDatabase());
  store.createAgent({ id: 'alpha', name: 'Alpha', model_id: MODEL, budget_cap_usd: 10, current_status: 'IDLE' });
  const approvals: Array<{ kind: string; payload: any }> = [];
  const gate = { request: async (params: { kind: string; payload?: Record<string, unknown> }) => { approvals.push({ kind: params.kind, payload: params.payload }); return { status: decision }; } };
  const repositories = fetcher();
  const { llm, requests } = scripted(steps);
  const runtime = new WorkRuntime({ store, ledger, llm, sandbox: new MemorySandbox() as never, artifacts: new ArtifactStore(store), repositories, approvals: gate as never });
  const chat = new ChatService({ agentStore: store, ledger, llmClient: llm, workRuntime: runtime, agenticChat: true });
  const queued = () => store.getDatabase().prepare("SELECT id, status FROM task_runs WHERE task_name = 'work:repository-example-calc'").all() as Array<{ id: string; status: string }>;
  return { store, chat, approvals, repositories, requests, queued, close: () => { ledger.close(); store.close(); } };
}

test('repository work stages the pinned snapshot, verifies with the project test command and delivers only a reviewable change', async () => {
  const h = harness([
    { tool: 'plan', steps: ['Read the add implementation', 'Fix the operator', 'Run the project tests'] },
    { tool: 'read', path: 'src/math.js' },
    { tool: 'write', path: 'src/math.js', content: FIXED },
    { tool: 'verify' },
    { tool: 'finish' },
  ]);
  try {
    const { result, read } = await h.execute();
    assert.equal(result.outcome, 'COMPLETED', result.report);
    assert.deepEqual(h.repositories!.requests, [{ owner: 'example', repo: 'calc', ref: COMMIT }], 'the pinned commit is fetched, not the moving branch');
    assert.deepEqual(result.artifacts.map(artifact => artifact.path).sort(), ['openhours-review/changes.patch', 'openhours-review/verification.txt', 'src/math.js']);
    assert.equal(read('openhours-review/changes.patch'), ['diff --git a/src/math.js b/src/math.js', '--- a/src/math.js', '+++ b/src/math.js', '@@ -1,3 +1,3 @@',
      ' export function add(a, b) {', '-  return a - b;', '+  return a + b;', ' }', ''].join('\n'));
    assert.equal(read('src/math.js'), FIXED);
    const review = read('openhours-review/verification.txt');
    assert.ok(review.startsWith(`Repository: example/calc at ${COMMIT}\nTest command: npm test\nChanged files: src/math.js\nNothing was published.`), review);
    assert.match(review, /ok 1 - add\(2, 3\) === 5/);
    assert.deepEqual(h.sandbox.installs.map(install => [install.manager, install.ignoreScripts]), [['npm', true], ['npm', true]], 'dependencies install in the work and verification workspaces without install scripts');
    assert.deepEqual(h.sandbox.commands.map(entry => entry.command), ['npm test']);
    const snapshot = h.events.find(event => event.type === 'REPOSITORY_SNAPSHOT')!.payload;
    assert.deepEqual([snapshot.commit, snapshot.archiveSha256, snapshot.files, snapshot.textBytes, snapshot.skipped], [COMMIT, 'f'.repeat(64), 4, 200, 1]);
    const prompt = h.requests[0].systemPrompt;
    assert.match(prompt, /Repository work on example\/calc: the workspace holds its text files/);
    assert.match(prompt, /"repositoryWork":"operator-started work on a public GitHub repository/);
    assert.doesNotMatch(prompt, /cloning, editing or testing an external repository/, 'repository work is not listed as unavailable inside repository work');
    assert.match(prompt, /verified GitHub publication/, 'publication is still stated as unavailable');
    assert.match(h.requests[0].messages![0].content, /"listedPaths":\["README\.md","package\.json","src\/math\.js","test\/math\.test\.js"\]/);
  } finally { h.close(); }
});

test('a change that fails the project tests is never delivered', async () => {
  const h = harness([
    { tool: 'write', path: 'src/math.js', content: BROKEN.replace('a - b', 'a * b') },
    { tool: 'verify' },
    { tool: 'finish' },
    { tool: 'block', reason: 'The project tests still fail and no further approach is available.' },
  ]);
  try {
    const { result } = await h.execute();
    assert.equal(result.outcome, 'FAILED');
    assert.deepEqual(result.artifacts, []);
    assert.match(result.report, /project tests still fail/);
    assert.deepEqual(h.events.filter(event => event.type === 'WORK_VERIFIED').map(event => event.payload.passed), [false]);
  } finally { h.close(); }
});

test('repository writes stay out of tool folders and changed tests are flagged for review', async () => {
  const h = harness([
    { tool: 'write', path: 'node_modules/evil/index.js', content: 'module.exports = 1;' },
    { tool: 'write', path: 'openhours-review/changes.patch', content: 'forged' },
    { tool: 'write', path: 'src/math.js', content: FIXED },
    { tool: 'write', path: 'test/math.test.js', content: "import { add } from '../src/math.js';\n// weakened\n" },
    { tool: 'verify' },
    { tool: 'finish' },
  ]);
  try {
    const { result, read } = await h.execute();
    assert.equal(result.outcome, 'COMPLETED', result.report);
    const refusals = h.events.filter(event => event.type === 'TOOL_CALL' && event.payload.status === 'error').map(event => String(event.payload.summary));
    assert.equal(refusals.filter(summary => /cannot write inside \.git, node_modules or openhours-review/.test(summary)).length, 2);
    assert.match(read('openhours-review/verification.txt'), /Tests or manifests changed; review these carefully: test\/math\.test\.js/);
    assert.match(read('openhours-review/changes.patch'), /^diff --git a\/src\/math\.js b\/src\/math\.js/);
    assert.match(read('openhours-review/changes.patch'), /\+\/\/ weakened/);
  } finally { h.close(); }
});

test('repository work refuses to run without repository support or when GitHub serves a different commit', async () => {
  const unavailable = harness([], { repositories: null });
  try {
    const { result } = await unavailable.execute();
    assert.equal(result.outcome, 'FAILED');
    assert.match(result.report, /Repository work is not available in this installation/);
  } finally { unavailable.close(); }
  const moved = harness([], { repositories: fetcher('d'.repeat(40)) });
  try {
    const { result } = await moved.execute();
    assert.equal(result.outcome, 'FAILED');
    assert.match(result.report, /different commit than this work was defined against/);
    assert.deepEqual(moved.sandbox.installs, [], 'nothing is installed for a mismatched snapshot');
  } finally { moved.close(); }
});

test('the system API defines repository work against the snapshot commit and queues it for the scheduler', async () => {
  const store = new AgentStore(':memory:');
  store.createAgent({ id: 'alpha', name: 'Alpha', model_id: MODEL, budget_cap_usd: 10, current_status: 'IDLE' });
  const repositories = fetcher();
  const services = { missions: {} as never, memory: {} as never, retention: {} as never, capacity: {} as never, abort: () => false };
  const api = systemApi({ ...services, store, repositories });
  const post = (body: unknown, target = api) => target('POST', new URL('http://127.0.0.1/api/system/repository-work'), body);
  try {
    const created = await post({ agentId: 'alpha', repository: 'https://github.com/example/calc/issues/7', request: 'Fix add().', testCommand: 'npm test' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const body = created.body as any;
    assert.deepEqual([body.repository, body.ref, body.commit, body.textFiles, body.skipped, body.testCommand], ['example/calc', 'HEAD', COMMIT, 4, 1, 'npm test']);
    assert.equal(store.getTaskRun(body.runId)!.status, 'QUEUED');
    const definition = store.getRunDefinition(body.runId) as any;
    const {snapshotKey,...target}=definition.work.contract.repository;
    assert.match(snapshotKey,/^[a-f0-9]{64}$/);
    assert.ok(store.getAgentData('alpha',snapshotKey,'repository-snapshot'));
    assert.deepEqual(target, { owner: 'example', repo: 'calc', ref: 'HEAD', commit: COMMIT });
    assert.equal(definition.work.contract.testCommand, 'npm test');
    assert.equal(definition.work.request, 'Fix add().');
    for (const bad of [
      { agentId: 'alpha', repository: 'not a repository', request: 'x', testCommand: 'npm test' },
      { agentId: 'ghost', repository: 'example/calc', request: 'x', testCommand: 'npm test' },
      { agentId: 'alpha', repository: 'example/calc', request: 'x' },
    ]) {
      assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
    }
    const refused = await post({ agentId: 'alpha', repository: 'example/calc', request: 'x', testCommand: 'npm test' }, systemApi(services));
    assert.equal(refused.status, 400);
    assert.match((refused.body as any).error, /Repository work is not available/);
    const unpinned = await post({ agentId: 'alpha', repository: 'example/calc', request: 'x', testCommand: 'npm test' }, systemApi({ ...services, store, repositories: fetcher(null) }));
    assert.equal(unpinned.status, 400);
    assert.match((unpinned.body as any).error, /did not identify the downloaded commit/);
  } finally { store.close(); }
});

test('a conversation proposes repository work, which is queued once, against the pinned commit, only after operator approval', async () => {
  const proposal = { tool: 'start_repository_work', repository: 'https://github.com/example/calc/issues/7', request: 'Fix add() so add(2, 3) returns 5.', testCommand: 'npm test' };
  const h = chatHarness([proposal], 'APPROVED');
  try {
    const thread = h.chat.createThread('alpha');
    const result = await h.chat.send(thread.id, 'Prepare a fix for issue 7 in example/calc.', 'repo-1');
    const prompt = h.requests[0].systemPrompt;
    assert.match(prompt, /propose \{"tool":"start_repository_work"/);
    assert.match(prompt, /propose start_repository_work for operator approval/);
    assert.deepEqual(h.approvals.map(approval => approval.kind), ['repository-work']);
    const payload = h.approvals[0].payload;
    assert.deepEqual([payload.repository, payload.commit, payload.request, payload.testCommand, payload.install, payload.textFiles, payload.publishes],
      ['example/calc', COMMIT, 'Fix add() so add(2, 3) returns 5.', 'npm test', 'auto', 4, false]);
    assert.equal(payload.question, `Queue isolated repository work on example/calc at ${COMMIT.slice(0, 12)}? Nothing will be published.`, 'the approval card shows a plain question');
    assert.ok(result.reply.content.startsWith(`Queued repository work on example/calc at ${COMMIT}: Fix add() so add(2, 3) returns 5.`), result.reply.content);
    assert.match(result.reply.content, /Nothing is published\./);
    const queued = h.queued();
    assert.deepEqual(queued.map(run => run.status), ['QUEUED']);
    assert.equal((h.store.getRunDefinition(queued[0].id) as any).work.contract.repository.commit, COMMIT);
    assert.match(result.reply.content, new RegExp(`Run ID: ${queued[0].id}$`));

    const replay = await h.chat.send(thread.id, 'Prepare a fix for issue 7 in example/calc.', 'repo-1');
    assert.equal(replay.reply.id, result.reply.id);
    assert.equal(h.queued().length, 1, 'a replayed request queues nothing more');
    assert.equal(h.approvals.length, 1, 'a replayed request asks for no second approval');
  } finally { h.close(); }
});

test('a declined repository work proposal queues nothing', async () => {
  const h = chatHarness([{ tool: 'start_repository_work', repository: 'example/calc', request: 'Fix add().', testCommand: 'npm test' }], 'DENIED');
  try {
    const result = await h.chat.send(h.chat.createThread('alpha').id, 'Fix example/calc.', 'repo-2');
    assert.match(result.reply.content, /Repository work was not approved\. Nothing was queued\./);
    assert.deepEqual(h.queued(), []);
    assert.equal(h.approvals.length, 1);
  } finally { h.close(); }
});

test('a mission advances from its selected issue into approved pinned repository work and records the verified patch', async () => {
  const store = new AgentStore(':memory:');
  const ledger = new CostLedger(store.getDatabase());
  store.createAgent({ id: 'alpha', name: 'Alpha', model_id: MODEL, budget_cap_usd: 10, current_status: 'IDLE' });
  let now = 1_000_000;
  const missions = new MissionService(store, DIRECT_WORK_CONTRACTS, 2, () => now);
  const mission = missions.create({ agentId: 'alpha', objective: 'Find and fix a real issue in example/calc.', contractId: 'evidence-brief', maxRuns: 2, intervalMs: 60_000 });
  const repositories = fetcher();
  const sandbox = new MemorySandbox();
  const artifacts = new ArtifactStore(store);
  const approvals: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  const gate = { request: async (request: { kind: string; payload?: Record<string, unknown> }) => { approvals.push(request); return { status: 'APPROVED' as const }; } };
  const { llm, requests } = scripted([
    { tool: 'start_repository_work', repository: 'https://github.com/example/calc/issues/7', request: 'Fix add() so add(2, 3) returns 5.', testCommand: 'npm test' },
    { tool: 'read', path: 'src/math.js' },
    { tool: 'write', path: 'src/math.js', content: FIXED },
    { tool: 'verify' },
    { tool: 'finish', mission: { state: 'complete', reason: 'The selected issue has a verified patch.' } },
  ]);
  const runtime = new WorkRuntime({ store, ledger, llm, sandbox: sandbox as never, artifacts, repositories, approvals: gate as never, missions, contracts: DIRECT_WORK_CONTRACTS });
  try {
    await missions.start();
    assert.equal(await missions.produceNextTasks(store), 1);
    const first = missions.list()[0].last_run_id!;
    store.startTaskRun(first, MODEL);
    missions.trackIssue(first, 'https://github.com/example/calc/issues/7', 'selected', 'The captured issue has a small reproducible arithmetic defect.');
    const firstDefinition = store.getRunDefinition(first) as { work: { contract: WorkContract; request: string; objective: string } };
    const staged = await runtime.execute({ taskRunId: first, contract: firstDefinition.work.contract, request: firstDefinition.work.request, objective: firstDefinition.work.objective, mission: true, signal: new AbortController().signal });
    assert.equal(staged.outcome, 'COMPLETED', staged.report);
    assert.equal(staged.mission?.state, 'continue');
    assert.deepEqual(staged.artifacts, [], 'staging is a control step, not a claimed code delivery');
    saveWorkResult(store, first, staged); store.finishTaskRun(first, staged.outcome);
    assert.deepEqual(approvals.map(approval => approval.kind), ['repository-work']);
    assert.equal(approvals[0].payload?.commit, COMMIT);
    assert.equal(missions.itemsForRun(first)[0].state, 'queued');

    assert.equal(await missions.produceNextTasks(store), 0, 'the interval remains enforced after staging');
    now += 60_000;
    assert.equal(await missions.produceNextTasks(store), 1);
    const second = missions.list()[0].last_run_id!;
    const secondDefinition = store.getRunDefinition(second) as { work: { contract: WorkContract; request: string; objective: string } };
    assert.deepEqual(secondDefinition.work.contract.repository, { owner: 'example', repo: 'calc', ref: 'HEAD', commit: COMMIT });
    assert.equal(secondDefinition.work.contract.testCommand, 'npm test');
    assert.match(secondDefinition.work.request, /Fix add\(\) so add\(2, 3\) returns 5/);
    assert.deepEqual(missions.itemsForRun(second).map(item => [item.state, item.task_run_id]), [['working', second]]);

    store.startTaskRun(second, MODEL);
    const delivered = await runtime.execute({ taskRunId: second, contract: secondDefinition.work.contract, request: secondDefinition.work.request, objective: secondDefinition.work.objective, mission: true, signal: new AbortController().signal });
    assert.equal(delivered.outcome, 'COMPLETED', delivered.report);
    assert.ok(delivered.artifacts.some(artifact => artifact.path === 'openhours-review/changes.patch'));
    saveWorkResult(store, second, delivered); store.finishTaskRun(second, delivered.outcome);
    assert.equal(await missions.produceNextTasks(store), 0);
    assert.equal(missions.list()[0].status, 'COMPLETED');
    assert.equal(missions.itemsForRun(second)[0].state, 'prepared');
    assert.deepEqual(repositories.requests, [{ owner: 'example', repo: 'calc', ref: 'HEAD' }, { owner: 'example', repo: 'calc', ref: COMMIT }]);
    assert.match(requests[0].systemPrompt, /stages the repository contract as this mission's next durable step/);
    assert.match(requests[1].systemPrompt, /Repository work on example\/calc/);
  } finally { await missions.stop(); ledger.close(); store.close(); }
});

test('mission repository work is refused before download or approval when no current selected issue matches', async () => {
  const store = new AgentStore(':memory:');
  const ledger = new CostLedger(store.getDatabase());
  store.createAgent({ id: 'alpha', name: 'Alpha', model_id: MODEL, budget_cap_usd: 10, current_status: 'IDLE' });
  const missions = new MissionService(store, DIRECT_WORK_CONTRACTS, 1);
  const repositories = fetcher();
  const approvals: unknown[] = [];
  const gate = { request: async (request: unknown) => { approvals.push(request); return { status: 'APPROVED' as const }; } };
  const action = { tool: 'start_repository_work', repository: 'example/calc', request: 'Fix add().', testCommand: 'npm test' };
  const { llm } = scripted([action, action, action]);
  const runtime = new WorkRuntime({ store, ledger, llm, sandbox: new MemorySandbox() as never, artifacts: new ArtifactStore(store), repositories, approvals: gate as never, missions, contracts: DIRECT_WORK_CONTRACTS });
  try {
    await missions.start();
    missions.create({ agentId: 'alpha', objective: 'Fix one selected issue.', contractId: 'evidence-brief', maxRuns: 2, intervalMs: 60_000 });
    await missions.produceNextTasks(store);
    const runId = missions.list()[0].last_run_id!;
    store.startTaskRun(runId, MODEL);
    const definition = store.getRunDefinition(runId) as { work: { contract: WorkContract; request: string; objective: string } };
    const result = await runtime.execute({ taskRunId: runId, contract: definition.work.contract, request: definition.work.request, objective: definition.work.objective, mission: true, signal: new AbortController().signal });
    assert.equal(result.outcome, 'FAILED');
    const failures = store.getTaskEvents(runId).filter(event => event.event_type === 'TOOL_CALL').map(event => JSON.parse(event.payload_json!).summary);
    assert.equal(failures.filter(summary => /Select a captured issue from example\/calc/.test(summary)).length, 3);
    assert.deepEqual(repositories.requests, []);
    assert.deepEqual(approvals, []);
  } finally { await missions.stop(); ledger.close(); store.close(); }
});
