import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { WorkRuntime } from '../src/daemon/work-runtime.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { turnLimit, CustomContractSchema, type WorkContract } from '../src/daemon/work-contract.js';
import type { ILLMClient, LLMRequest } from '../src/evals/llm-client.js';
import type { SearchWorkspaceParams, ShellSession } from '../src/kernel/docker-sandbox.js';

const MODEL = 'claude-haiku-4-5';

class MockSandbox {
  files = new Map<string, string>();
  executedCommands: string[] = [];
  searchCalls: Array<{ mode: string; params: SearchWorkspaceParams }> = [];
  shellStarted = false;
  shellStopped = false;
  execInShellCalls: string[] = [];

  async createWorkspaceVolume(taskId: string): Promise<string> {
    return `mock-vol-${taskId}`;
  }

  async stageWorkspaceFiles(volume: string, files: Record<string, string>): Promise<void> {
    for (const [p, c] of Object.entries(files)) {
      this.files.set(p, c);
    }
  }

  async readWorkspaceFile(volume: string, filePath: string, maxBytes = 262_144): Promise<{ content: string; truncated: boolean }> {
    const content = this.files.get(filePath);
    if (content === undefined) throw new Error(`File not found: ${filePath}`);
    const truncated = content.length > maxBytes;
    return { content: content.slice(0, maxBytes), truncated };
  }

  async executeTask(volume: string, command: string, options: { onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void; runtime?: string } = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.executedCommands.push(command);
    return { exitCode: 0, stdout: 'ok\n', stderr: '' };
  }

  async destroyWorkspaceVolume(volume: string): Promise<void> {
    // Keep files for test assertions
  }

  async searchWorkspace(volume: string, mode: 'list' | 'glob' | 'grep', params: SearchWorkspaceParams = {}): Promise<string> {
    this.searchCalls.push({ mode, params });
    if (mode === 'list') {
      return 'src/\nsrc/app.ts\npackage.json';
    }
    if (mode === 'glob') {
      return 'src/app.ts';
    }
    if (mode === 'grep') {
      return 'src/app.ts:1:export function hello()';
    }
    return '';
  }

  async startShell(volume: string, options: { runtime?: 'node' | 'python' } = {}): Promise<ShellSession> {
    this.shellStarted = true;
    return {
      containerName: 'mock-shell-container',
      volumeName: volume,
      runtime: options.runtime ?? 'node',
      lastWorkDir: '/workspace',
    };
  }

  async execInShell(session: ShellSession, command: string, options: any = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.execInShellCalls.push(command);
    if (command.startsWith('cd ')) {
      session.lastWorkDir = command.slice(3).trim();
    }
    return { exitCode: 0, stdout: `Executed: ${command}\n`, stderr: '' };
  }

  async stopShell(session: ShellSession | string): Promise<void> {
    this.shellStopped = true;
  }
}

class ScriptedLLM implements ILLMClient {
  requests: LLMRequest[] = [];
  constructor(private actions: unknown[]) {}
  async generateCode(request: LLMRequest) {
    this.requests.push({ ...request, messages: request.messages?.map(m => ({ ...m })) });
    const action = this.actions.shift() ?? { tool: 'block', reason: 'No further actions in fixture.' };
    return {
      content: typeof action === 'string' ? action : JSON.stringify(action),
      inputTokens: 100,
      outputTokens: 100,
      attemptCount: 1,
    };
  }
}

function createHarness(actions: unknown[], sandbox: MockSandbox) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-test-coding-tools-'));
  const store = new AgentStore(path.join(dir, 'test.db'));
  const ledger = new CostLedger(store.getDatabase());
  const artifacts = new ArtifactStore(store);
  const llm = new ScriptedLLM(actions);

  store.createAgent({
    id: 'worker',
    name: 'Worker',
    model_id: MODEL,
    system_prompt: 'System prompt',
    budget_cap_usd: 10,
    current_status: 'IDLE',
  });

  const runtime = new WorkRuntime({
    store,
    ledger,
    llm,
    sandbox: sandbox as any,
    artifacts,
  });

  return {
    store,
    ledger,
    artifacts,
    llm,
    runtime,
    sandbox,
    close: () => {
      ledger.close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('Phase 3: Coding Tools', () => {
  describe('turnLimit', () => {
    it('returns 80 for repository work', () => {
      const contract: Pick<WorkContract, 'repository' | 'kind' | 'maxTurns'> = {
        repository: { owner: 'test', repo: 'test', ref: 'main' },
        kind: 'code',
      };
      assert.equal(turnLimit(contract), 80);
    });

    it('returns 60 for standalone code tasks', () => {
      const contract: Pick<WorkContract, 'repository' | 'kind' | 'maxTurns'> = {
        kind: 'code',
      };
      assert.equal(turnLimit(contract), 60);
    });

    it('returns 60 for reports and plans', () => {
      assert.equal(turnLimit({ kind: 'report' }), 60);
      assert.equal(turnLimit({ kind: 'plan' }), 60);
    });

    it('returns 60 for scheduled routine runs', () => {
      assert.equal(turnLimit({ kind: 'code' }, { scheduled: true }), 60);
      assert.equal(turnLimit({ kind: 'code' }, { scheduled: { routineId: 'r-1' } }), 60);
    });

    it('returns 60 for conversational chat', () => {
      assert.equal(turnLimit({ kind: 'code' }, { conversation: true }), 60);
    });

    it('respects custom maxTurns within upper bound', () => {
      assert.equal(turnLimit({ kind: 'code', maxTurns: 40 }), 40);
      assert.equal(turnLimit({ kind: 'code', maxTurns: 100 }), 60);
    });
  });

  describe('read with offset and limit', () => {
    it('returns numbered lines when offset and limit are provided', async () => {
      const sandbox = new MockSandbox();
      sandbox.files.set('src/index.js', 'line one\nline two\nline three\nline four\nline five');

      const custom = CustomContractSchema.parse({
        id: 'custom-read-test',
        name: 'Read test',
        description: 'Read file test',
        requirements: ['pass'],
        initialFiles: { 'src/index.js': sandbox.files.get('src/index.js')!, 'test.js': 'console.log("ok");' },
        writableFiles: ['src/index.js'],
        testCommand: 'echo ok',
      });

      const h = createHarness([
        { tool: 'read', path: 'src/index.js', offset: 2, limit: 3 },
        { tool: 'write', path: 'src/index.js', content: 'line one\nline two\nline three\nline four\nline five' },
        { tool: 'verify' },
        { tool: 'finish' },
      ], sandbox);

      const run = h.store.createTaskRun({ agentId: 'worker', taskName: custom.id });
      h.store.startTaskRun(run.id, MODEL);

      try {
        const result = await h.runtime.execute({
          taskRunId: run.id,
          contract: custom,
          request: 'Read the file',
          signal: new AbortController().signal,
        });
        assert.equal(result.outcome, 'COMPLETED');

        // Verify read observation had numbered lines
        const toolCalls = h.store.getTaskEvents(run.id).filter(e => e.event_type === 'TOOL_CALL');
        const readCall = toolCalls.find(e => JSON.parse(e.payload_json!).tool === 'read');
        assert.ok(readCall);
        const payload = JSON.parse(readCall.payload_json!);
        assert.equal(payload.summary, '2: line two\n3: line three\n4: line four');
        assert.equal(payload.offset, 2);
        assert.equal(payload.limit, 3);
        assert.equal(payload.totalLines, 5);
      } finally {
        h.close();
      }
    });

    it('returns raw content when offset and limit are omitted', async () => {
      const sandbox = new MockSandbox();
      sandbox.files.set('src/index.js', 'line one\nline two\nline three');

      const custom = CustomContractSchema.parse({
        id: 'custom-read-raw',
        name: 'Read raw test',
        description: 'Read raw test',
        requirements: ['pass'],
        initialFiles: { 'src/index.js': sandbox.files.get('src/index.js')!, 'test.js': 'console.log("ok");' },
        writableFiles: ['src/index.js'],
        testCommand: 'echo ok',
      });

      const h = createHarness([
        { tool: 'read', path: 'src/index.js' },
        { tool: 'write', path: 'src/index.js', content: 'line one\nline two\nline three' },
        { tool: 'verify' },
        { tool: 'finish' },
      ], sandbox);

      const run = h.store.createTaskRun({ agentId: 'worker', taskName: custom.id });
      h.store.startTaskRun(run.id, MODEL);

      try {
        const result = await h.runtime.execute({
          taskRunId: run.id,
          contract: custom,
          request: 'Read raw file',
          signal: new AbortController().signal,
        });
        assert.equal(result.outcome, 'COMPLETED');

        const toolCalls = h.store.getTaskEvents(run.id).filter(e => e.event_type === 'TOOL_CALL');
        const readCall = toolCalls.find(e => JSON.parse(e.payload_json!).tool === 'read');
        const payload = JSON.parse(readCall!.payload_json!);
        assert.equal(payload.summary, 'line one\nline two\nline three');
      } finally {
        h.close();
      }
    });
  });

  describe('edit tool', () => {
    it('performs surgical string replacement and emits unified diff', async () => {
      const sandbox = new MockSandbox();
      sandbox.files.set('src/app.js', 'function add(a, b) {\n  return a - b;\n}\n');
      sandbox.files.set('test.js', 'console.log("ok");');

      const custom = CustomContractSchema.parse({
        id: 'custom-edit-test',
        name: 'Edit test',
        description: 'Edit test',
        requirements: ['pass'],
        initialFiles: { 'src/app.js': sandbox.files.get('src/app.js')!, 'test.js': 'console.log("ok");' },
        writableFiles: ['src/app.js'],
        testCommand: 'echo ok',
      });

      const h = createHarness([
        { tool: 'edit', path: 'src/app.js', old_string: 'return a - b;', new_string: 'return a + b;' },
        { tool: 'verify' },
        { tool: 'finish' },
      ], sandbox);

      const run = h.store.createTaskRun({ agentId: 'worker', taskName: custom.id });
      h.store.startTaskRun(run.id, MODEL);

      try {
        const result = await h.runtime.execute({
          taskRunId: run.id,
          contract: custom,
          request: 'Fix addition',
          signal: new AbortController().signal,
        });
        assert.equal(result.outcome, 'COMPLETED');

        assert.equal(sandbox.files.get('src/app.js'), 'function add(a, b) {\n  return a + b;\n}\n');

        const toolCalls = h.store.getTaskEvents(run.id).filter(e => e.event_type === 'TOOL_CALL');
        const editCall = toolCalls.find(e => JSON.parse(e.payload_json!).tool === 'edit');
        assert.ok(editCall);
        const payload = JSON.parse(editCall.payload_json!);
        assert.ok(payload.summary.includes('Edited src/app.js'));
        assert.equal(payload.presentation.diff.added, 1);
        assert.equal(payload.presentation.diff.removed, 1);
      } finally {
        h.close();
      }
    });

    it('rejects edit when old_string occurs multiple times without replace_all', async () => {
      const sandbox = new MockSandbox();
      sandbox.files.set('src/app.js', 'const x = 1;\nconst y = 1;\n');
      sandbox.files.set('test.js', 'console.log("ok");');

      const custom = CustomContractSchema.parse({
        id: 'custom-edit-multi',
        name: 'Edit multi test',
        description: 'Edit multi test',
        requirements: ['pass'],
        initialFiles: { 'src/app.js': sandbox.files.get('src/app.js')!, 'test.js': 'console.log("ok");' },
        writableFiles: ['src/app.js'],
        testCommand: 'echo ok',
      });

      const h = createHarness([
        { tool: 'edit', path: 'src/app.js', old_string: '1;', new_string: '2;' },
        { tool: 'edit', path: 'src/app.js', old_string: '1;', new_string: '2;', replace_all: true },
        { tool: 'verify' },
        { tool: 'finish' },
      ], sandbox);

      const run = h.store.createTaskRun({ agentId: 'worker', taskName: custom.id });
      h.store.startTaskRun(run.id, MODEL);

      try {
        const result = await h.runtime.execute({
          taskRunId: run.id,
          contract: custom,
          request: 'Replace values',
          signal: new AbortController().signal,
        });
        assert.equal(result.outcome, 'COMPLETED');

        const toolCalls = h.store.getTaskEvents(run.id).filter(e => e.event_type === 'TOOL_CALL');
        const firstEdit = JSON.parse(toolCalls[0].payload_json!);
        assert.equal(firstEdit.status, 'error');
        assert.ok(firstEdit.summary.includes('occurs 2 times'));

        const secondEdit = JSON.parse(toolCalls[1].payload_json!);
        assert.equal(secondEdit.status, 'ok');
        assert.equal(sandbox.files.get('src/app.js'), 'const x = 2;\nconst y = 2;\n');
      } finally {
        h.close();
      }
    });

    it('handles CRLF vs LF retry when file endings differ from model input', async () => {
      const sandbox = new MockSandbox();
      // File has CRLF endings
      sandbox.files.set('src/app.js', 'line 1\r\nline 2\r\nline 3\r\n');
      sandbox.files.set('test.js', 'console.log("ok");');

      const custom = CustomContractSchema.parse({
        id: 'custom-edit-crlf',
        name: 'Edit CRLF test',
        description: 'Edit CRLF test',
        requirements: ['pass'],
        initialFiles: { 'src/app.js': sandbox.files.get('src/app.js')!, 'test.js': 'console.log("ok");' },
        writableFiles: ['src/app.js'],
        testCommand: 'echo ok',
      });

      // Model sends LF endings
      const h = createHarness([
        { tool: 'edit', path: 'src/app.js', old_string: 'line 1\nline 2', new_string: 'line 1\nline two' },
        { tool: 'verify' },
        { tool: 'finish' },
      ], sandbox);

      const run = h.store.createTaskRun({ agentId: 'worker', taskName: custom.id });
      h.store.startTaskRun(run.id, MODEL);

      try {
        const result = await h.runtime.execute({
          taskRunId: run.id,
          contract: custom,
          request: 'Fix line two',
          signal: new AbortController().signal,
        });
        assert.equal(result.outcome, 'COMPLETED');
        // Check that CRLF was preserved
        assert.equal(sandbox.files.get('src/app.js'), 'line 1\r\nline two\r\nline 3\r\n');
      } finally {
        h.close();
      }
    });
  });

  describe('search tools (list, glob, grep)', () => {
    it('dispatches list, glob, and grep to sandbox.searchWorkspace', async () => {
      const sandbox = new MockSandbox();
      sandbox.files.set('src/app.js', 'console.log("hello")');
      sandbox.files.set('test.js', 'console.log("ok");');

      const custom = CustomContractSchema.parse({
        id: 'custom-search-test',
        name: 'Search test',
        description: 'Search test',
        requirements: ['pass'],
        initialFiles: { 'src/app.js': 'console.log("hello")', 'test.js': 'console.log("ok");' },
        writableFiles: ['src/app.js'],
        testCommand: 'echo ok',
      });

      const h = createHarness([
        { tool: 'list', path: 'src', depth: 2 },
        { tool: 'glob', pattern: '**/*.ts' },
        { tool: 'grep', pattern: 'hello', path: 'src', ignoreCase: true },
        { tool: 'write', path: 'src/app.js', content: 'console.log("hello")' },
        { tool: 'verify' },
        { tool: 'finish' },
      ], sandbox);

      const run = h.store.createTaskRun({ agentId: 'worker', taskName: custom.id });
      h.store.startTaskRun(run.id, MODEL);

      try {
        const result = await h.runtime.execute({
          taskRunId: run.id,
          contract: custom,
          request: 'Search the files',
          signal: new AbortController().signal,
        });
        assert.equal(result.outcome, 'COMPLETED');

        assert.equal(sandbox.searchCalls.length, 3);
        assert.deepEqual(sandbox.searchCalls[0], { mode: 'list', params: { path: 'src', depth: 2 } });
        assert.deepEqual(sandbox.searchCalls[1], { mode: 'glob', params: { pattern: '**/*.ts' } });
        assert.deepEqual(sandbox.searchCalls[2], { mode: 'grep', params: { pattern: 'hello', path: 'src', glob: undefined, ignoreCase: true } });
      } finally {
        h.close();
      }
    });
  });

  describe('diff tool', () => {
    it('returns unified diff of changed files against initial snapshot', async () => {
      const sandbox = new MockSandbox();
      sandbox.files.set('src/app.js', 'export const x = 1;\n');
      sandbox.files.set('test.js', 'console.log("ok");');

      const custom = CustomContractSchema.parse({
        id: 'custom-diff-test',
        name: 'Diff test',
        description: 'Diff test',
        requirements: ['pass'],
        initialFiles: { 'src/app.js': 'export const x = 1;\n', 'test.js': 'console.log("ok");' },
        writableFiles: ['src/app.js'],
        testCommand: 'echo ok',
      });

      const h = createHarness([
        { tool: 'diff' }, // before write -> no changes
        { tool: 'write', path: 'src/app.js', content: 'export const x = 2;\n' },
        { tool: 'diff' }, // after write -> shows diff
        { tool: 'verify' },
        { tool: 'finish' },
      ], sandbox);

      const run = h.store.createTaskRun({ agentId: 'worker', taskName: custom.id });
      h.store.startTaskRun(run.id, MODEL);

      try {
        const result = await h.runtime.execute({
          taskRunId: run.id,
          contract: custom,
          request: 'Diff test',
          signal: new AbortController().signal,
        });
        assert.equal(result.outcome, 'COMPLETED');

        const toolCalls = h.store.getTaskEvents(run.id).filter(e => e.event_type === 'TOOL_CALL');
        const diffCalls = toolCalls.filter(e => JSON.parse(e.payload_json!).tool === 'diff');
        assert.equal(diffCalls.length, 2);

        const firstDiff = JSON.parse(diffCalls[0].payload_json!);
        assert.equal(firstDiff.summary, 'No changes.');

        const secondDiff = JSON.parse(diffCalls[1].payload_json!);
        assert.ok(secondDiff.summary.includes('-export const x = 1;'));
        assert.ok(secondDiff.summary.includes('+export const x = 2;'));
      } finally {
        h.close();
      }
    });
  });

  describe('tool-result pruning', () => {
    it('prunes observations older than 4 turns that exceed 2 KB', async () => {
      const sandbox = new MockSandbox();
      sandbox.files.set('src/app.js', 'export const x = 1;\n');
      sandbox.files.set('test.js', 'console.log("ok");');

      const custom = CustomContractSchema.parse({
        id: 'custom-pruning-test',
        name: 'Pruning test',
        description: 'Pruning test',
        requirements: ['pass'],
        initialFiles: { 'src/app.js': 'export const x = 1;\n', 'test.js': 'console.log("ok");' },
        writableFiles: ['src/app.js'],
        testCommand: 'echo ok',
      });

      // Generate a 4 KB output
      const largeOutput = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}: ${'x'.repeat(40)}`).join('\n');
      assert.ok(Buffer.byteLength(largeOutput, 'utf8') > 3000);

      // Turn 1: run command producing large output
      // Turn 2: write
      // Turn 3: diff
      // Turn 4: diff
      // Turn 5: before this turn, turn 1's tool result (>=4 turns older) must be pruned
      const actions = [
        { tool: 'run', command: 'generate-large' },
        { tool: 'write', path: 'src/app.js', content: 'export const x = 2;\n' },
        { tool: 'diff' },
        { tool: 'diff' },
        { tool: 'verify' },
        { tool: 'finish' },
      ];

      // Custom sandbox to return largeOutput for the run tool
      const originalExecInShell = sandbox.execInShell.bind(sandbox);
      sandbox.execInShell = async (s, cmd, opts) => {
        if (cmd === 'generate-large') {
          return { exitCode: 0, stdout: largeOutput, stderr: '' };
        }
        return originalExecInShell(s, cmd, opts);
      };
      const originalExecute = sandbox.executeTask.bind(sandbox);
      sandbox.executeTask = async (v, cmd, opts) => {
        if (cmd === 'generate-large') {
          return { exitCode: 0, stdout: largeOutput, stderr: '' };
        }
        return originalExecute(v, cmd, opts);
      };

      const h = createHarness(actions, sandbox);
      const run = h.store.createTaskRun({ agentId: 'worker', taskName: custom.id });
      h.store.startTaskRun(run.id, MODEL);

      try {
        const result = await h.runtime.execute({
          taskRunId: run.id,
          contract: custom,
          request: 'Pruning test',
          signal: new AbortController().signal,
        });
        assert.equal(result.outcome, 'COMPLETED');

        // Check LLM requests at turn 5
        const lastRequest = h.llm.requests.at(-1)!;
        const toolMsg = lastRequest.messages?.find(m => m.role === 'user' && m.content.includes('pruned from earlier turn'));
        assert.ok(toolMsg, 'Expected a pruned tool message in turn 5+ messages');
        assert.ok(toolMsg!.content.includes('bytes pruned from earlier turn'));
      } finally {
        h.close();
      }
    });
  });
});
