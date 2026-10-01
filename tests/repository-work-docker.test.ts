/**
 * Repository work against real Docker: the project's own tests run offline in a fresh verification workspace.
 * A passing change is delivered as changed files plus a patch; a failing change is never delivered.
 * The repository snapshot is an in-memory fixture, so no network is used.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { WorkRuntime } from '../src/daemon/work-runtime.js';
import { DockerSandbox } from '../src/kernel/docker-sandbox.js';
import { resolveDockerHost } from '../src/kernel/docker-host.js';
import { repositoryWorkContract } from '../src/daemon/work-contract.js';
import type { RepositoryRef, RepositorySnapshot } from '../src/daemon/repository-snapshot.js';
import type { LLMRequest } from '../src/evals/llm-client.js';

const MODEL = 'claude-haiku-4-5';
const COMMIT = 'b'.repeat(40);
const dockerHost = resolveDockerHost();
const dockerReady = spawnSync(dockerHost.command, [...dockerHost.prefixArgs, 'version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 15_000, windowsHide: true }).status === 0;
const FILES: Record<string, string> = {
  'package.json': '{"name":"calc","type":"module","scripts":{"test":"node --test"}}\n',
  'src/math.js': 'export function add(a, b) {\n  return a - b;\n}\n',
  'test/math.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n\ntest('adds two numbers', () => {\n  assert.equal(add(2, 3), 5);\n});\n",
};
const FIXED = 'export function add(a, b) {\n  return a + b;\n}\n';
const WRONG = 'export function add(a, b) {\n  return a * b;\n}\n';

test('binary assets, deletion and rename survive real isolated repository verification', {skip:dockerReady?false:'Docker is not available'}, async()=>{
  const store=new AgentStore(':memory:');store.createAgent({id:'binary-bot',name:'Binary',model_id:MODEL,budget_cap_usd:10,current_status:'IDLE'});
  const ledger=new CostLedger(store.getDatabase()),artifacts=new ArtifactStore(store),sandbox=new DockerSandbox();
  const steps:unknown[]=[{tool:'rename_file',path:'old.bin',destination:'renamed.bin'},{tool:'delete_file',path:'remove.txt'},
    {tool:'run',command:`node -e "require('fs').writeFileSync('new.bin',Buffer.from([0,255,42]))"`},{tool:'register_file',path:'new.bin'},{tool:'verify'},{tool:'finish'}];
  const contract=repositoryWorkContract({owner:'example',repo:'binary',ref:'main',commit:COMMIT},`node -e "const f=require('fs'),a=require('assert');a(!f.existsSync('old.bin'));a(!f.existsSync('remove.txt'));a.deepEqual([...f.readFileSync('renamed.bin')],[0,254]);a.deepEqual([...f.readFileSync('new.bin')],[0,255,42]);"`,'none','Rename and add binary assets; delete obsolete text');
  const run=store.createTaskRun({agentId:'binary-bot',taskName:'binary'});store.startTaskRun(run.id,MODEL);
  const runtime=new WorkRuntime({store,ledger,artifacts,sandbox,repositories:{snapshot:async repository=>({repository,source:'fixture',commit:COMMIT,archiveSha256:'e'.repeat(64),fetchedAt:new Date().toISOString(),files:{'remove.txt':'remove me'},binaries:{'old.bin':'AP4='},skipped:[],textBytes:9})},
    llm:{async generateCode(){const step=steps.shift();assert(step,'No extra model calls');return{content:JSON.stringify(step),inputTokens:10,outputTokens:10,attemptCount:1};}}});
  try{const result=await runtime.execute({taskRunId:run.id,contract,request:'Perform the requested file operations',signal:new AbortController().signal});assert.equal(result.outcome,'COMPLETED',result.report);
    const read=(p:string)=>artifacts.read(run.id,result.artifacts.find(a=>a.path===p)!.id)!;assert.equal(read('new.bin').content,'AP8q');assert.equal(read('renamed.bin').content,'AP4=');assert.equal(read('new.bin').encoding,'base64');
    assert.deepEqual(JSON.parse(read('openhours-review/changes.json').content).deleted,['old.bin','remove.txt']);
  }finally{ledger.close();store.close();}
});

test('repository work runs the project tests in real isolated Docker workspaces and delivers only a passing, reviewable change', { skip: dockerReady ? false : 'Docker is not available' }, async () => {
  for (const scenario of ['fixed', 'still-failing'] as const) {
    const store = new AgentStore(':memory:');
    const ledger = new CostLedger(store.getDatabase());
    store.createAgent({ id: 'alpha', name: 'Alpha', model_id: MODEL, budget_cap_usd: 10, current_status: 'IDLE' });
    const artifacts = new ArtifactStore(store);
    const sandbox = new DockerSandbox();
    const events: Array<{ type: string; payload: any }> = [];
    store.setEventSink(event => events.push({ type: event.event_type, payload: JSON.parse(event.payload_json) }));
    const steps: unknown[] = scenario === 'fixed'
      ? [{ tool: 'write', path: 'src/math.js', content: FIXED }, { tool: 'verify' }, { tool: 'finish' }]
      : [{ tool: 'write', path: 'src/math.js', content: WRONG }, { tool: 'verify' }, { tool: 'block', reason: 'The project tests still fail.' }];
    const llm = { async generateCode(_req: LLMRequest) {
      const step = steps.shift();
      assert.ok(step !== undefined, 'no extra model call is scripted');
      return { content: JSON.stringify(step), inputTokens: 10, outputTokens: 10, attemptCount: 1 };
    } };
    const repositories = { snapshot: async (repository: RepositoryRef): Promise<RepositorySnapshot> => ({ repository, source: 'fixture', archiveSha256: 'e'.repeat(64), commit: COMMIT,
      fetchedAt: new Date().toISOString(), files: { ...FILES }, skipped: [], textBytes: 1 }) };
    const runtime = new WorkRuntime({ store, ledger, llm, sandbox, artifacts, repositories });
    const contract = repositoryWorkContract({ owner: 'example', repo: 'calc', ref: 'main', commit: COMMIT }, 'node --test', 'none', 'Fix add() so add(2, 3) returns 5.');
    const run = store.createTaskRun({ agentId: 'alpha', taskName: `work:${contract.id}` });
    store.startTaskRun(run.id, MODEL);
    try {
      const result = await runtime.execute({ taskRunId: run.id, contract, request: 'Fix add() so add(2, 3) returns 5.', signal: new AbortController().signal });
      const verification = events.filter(event => event.type === 'WORK_VERIFIED').map(event => event.payload);
      assert.equal(verification.length, 1, scenario);
      if (scenario === 'fixed') {
        assert.equal(result.outcome, 'COMPLETED', result.report);
        assert.deepEqual([verification[0].passed, verification[0].exitCode], [true, 0]);
        assert.match(verification[0].output, /pass 1/);
        assert.deepEqual(result.artifacts.map(artifact => artifact.path).sort(), ['openhours-review/changes.patch', 'openhours-review/verification.txt', 'src/math.js']);
        const patch = artifacts.read(run.id, result.artifacts.find(artifact => artifact.path === 'openhours-review/changes.patch')!.id)!.content;
        assert.match(patch, /^diff --git a\/src\/math\.js b\/src\/math\.js\n--- a\/src\/math\.js\n\+\+\+ b\/src\/math\.js\n@@ -1,3 \+1,3 @@\n export function add\(a, b\) \{\n-  return a - b;\n\+  return a \+ b;\n \}\n$/);
      } else {
        assert.equal(result.outcome, 'FAILED');
        assert.deepEqual(result.artifacts, []);
        assert.equal(verification[0].passed, false);
        assert.notEqual(verification[0].exitCode, 0);
        assert.match(verification[0].output, /fail 1/);
      }
    } finally {
      await sandbox.destroyWorkspaceVolume(sandbox.workspaceVolumeName(`task-${run.id}`)).catch(() => undefined);
      ledger.close();
      store.close();
    }
  }
});

test('persistent shell preserves working directory across run calls in Docker', { skip: dockerReady ? false : 'Docker is not available' }, async () => {
  const sandbox = new DockerSandbox();
  const volume = await sandbox.createWorkspaceVolume('test-shell-pwd');
  try {
    const session = await sandbox.startShell(volume);
    try {
      const res1 = await sandbox.execInShell(session, 'mkdir -p sub && cd sub');
      assert.equal(res1.exitCode, 0);
      const res2 = await sandbox.execInShell(session, 'pwd');
      assert.equal(res2.exitCode, 0);
      assert.match(res2.stdout.trim(), /\/workspace\/sub$/);
      const res3 = await sandbox.execInShell(session, 'mkdir -p \'odd"$(touch INJECTED)\' && cd \'odd"$(touch INJECTED)\' && exit 7');
      assert.equal(res3.exitCode, 7);
      const res4 = await sandbox.execInShell(session, 'pwd; test ! -e /workspace/sub/INJECTED');
      assert.equal(res4.exitCode, 0, res4.stderr);
      assert.equal(res4.stdout.trim(), '/workspace/sub/odd"$(touch INJECTED)');
    } finally {
      await sandbox.stopShell(session);
    }
  } finally {
    await sandbox.destroyWorkspaceVolume(volume).catch(() => undefined);
  }
});

test('Docker argv never expands shell syntax on the host', { skip: dockerReady ? false : 'Docker is not available' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'openagents-argv-'));
  try {
    const literal = 'literal$(touch OH_ARGV_SENTINEL)';
    const result = spawnSync(dockerHost.command, [...dockerHost.prefixArgs, 'version', '--format', literal], { cwd: dir, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), literal);
    assert.equal(existsSync(path.join(dir, 'OH_ARGV_SENTINEL')), false, 'Docker arguments executed on the host');
  } finally {
    // WSL may retain its cwd handle briefly after docker exits. Cleanup must not hide assertions.
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* empty temporary fixture only */ }
  }
});

test('repository work with python runtime passes runtime to contract and sandbox', { skip: dockerReady ? false : 'Docker is not available' }, async () => {
  const PYTHON_FILES: Record<string, string> = {
    'src/math_calc.py': 'def add(a, b):\n    return a - b\n',
    'tests/test_math.py': "import unittest\nfrom src.math_calc import add\n\nclass MathTest(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n",
  };
  const PYTHON_FIXED = 'def add(a, b):\n    return a + b\n';
  const store = new AgentStore(':memory:');
  const ledger = new CostLedger(store.getDatabase());
  store.createAgent({ id: 'alpha', name: 'Alpha', model_id: MODEL, budget_cap_usd: 10, current_status: 'IDLE' });
  const artifacts = new ArtifactStore(store);
  const sandbox = new DockerSandbox();
  const steps: unknown[] = [
    { tool: 'write', path: 'src/math_calc.py', content: PYTHON_FIXED },
    { tool: 'verify' },
    { tool: 'finish' },
  ];
  const llm = { async generateCode(_req: LLMRequest) {
    const step = steps.shift();
    return { content: JSON.stringify(step), inputTokens: 10, outputTokens: 10, attemptCount: 1 };
  } };
  const repositories = { snapshot: async (repository: RepositoryRef): Promise<RepositorySnapshot> => ({
    repository, source: 'fixture', archiveSha256: 'f'.repeat(64), commit: COMMIT,
    fetchedAt: new Date().toISOString(), files: { ...PYTHON_FILES }, skipped: [], textBytes: 1
  }) };
  const runtime = new WorkRuntime({ store, ledger, llm, sandbox, artifacts, repositories });
  const contract = repositoryWorkContract({ owner: 'example', repo: 'pycalc', ref: 'main', commit: COMMIT }, 'python -m unittest discover -s tests', 'none', 'Fix add() in Python', 'python');
  assert.equal(contract.runtime, 'python');
  const run = store.createTaskRun({ agentId: 'alpha', taskName: `work:${contract.id}` });
  store.startTaskRun(run.id, MODEL);
  try {
    const result = await runtime.execute({ taskRunId: run.id, contract, request: 'Fix add() in Python', signal: new AbortController().signal });
    assert.equal(result.outcome, 'COMPLETED', result.report);
  } finally {
    await sandbox.destroyWorkspaceVolume(sandbox.workspaceVolumeName(`task-${run.id}`)).catch(() => undefined);
    ledger.close();
    store.close();
  }
});
