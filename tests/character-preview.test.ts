import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CharacterStore } from '../src/daemon/character-store.js';
import { RunCapacity } from '../src/daemon/run-capacity.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import {
  type ILLMClient,
  type LLMRequest,
  type LLMResponse,
} from '../src/evals/llm-client.js';
import {
  CharacterPreviewService,
  type CharacterPreviewResult,
} from '../src/daemon/character-preview.js';
import { CharacterBusyError } from '../src/daemon/character-schema.js';

test('invalid drafts and missing bots are rejected before any run or model call', async () => {
  const { agentStore, llm, capacity, previewService, agent } = setupTestEnvironment();
  await assert.rejects(previewService.preview({ agentId: 'missing', situation: { type: 'post', about: 'test' } }));
  await assert.rejects(previewService.preview({ agentId: agent.id, situation: { type: 'post', about: 'test' },
    draft: { document: { voice: { rules: { casing: 'invalid' as any } } } } }));
  assert.equal(agentStore.listTaskRuns().length, 0);
  assert.equal(llm.requests.length, 0);
  assert.equal(capacity.used, 0);
});

test('provider failure terminates the inspection and reports unknown usage honestly', async () => {
  const { agentStore, llm, capacity, previewService, agent } = setupTestEnvironment();
  llm.handler = () => { throw new Error('dispatched but response lost'); };
  const result = await previewService.preview({ agentId: agent.id, situation: { type: 'post', about: 'test' } });
  assert.equal(agentStore.getTaskRun(result.runId)?.status, 'FAILED');
  assert.equal(result.ok, false);
  assert.equal(result.usage.usageKnown, false);
  assert.equal(result.usage.costUsd, null);
  assert.equal(result.wireAttempts, null);
  assert.equal(result.logicalCalls, 1);
  assert.equal(capacity.used, 0);
});

test('an active preview protects its bot from deletion and cancelled requests spend nothing', async () => {
  const { agentStore, llm, previewService, agent, capacity } = setupTestEnvironment();
  const ac = new AbortController();
  llm.handler = async () => new Promise(() => {});
  const pending = previewService.preview({ agentId: agent.id, signal: ac.signal, situation: { type: 'post', about: 'test' } });
  assert.throws(() => agentStore.deleteAgent(agent.id));
  ac.abort();
  await assert.rejects(pending);
  assert.equal(capacity.used, 0);
  const calls = llm.requests.length;
  await assert.rejects(previewService.preview({ agentId: agent.id, signal: ac.signal, situation: { type: 'post', about: 'test' } }));
  assert.equal(llm.requests.length, calls);
  assert.equal(agentStore.queuedTaskRuns().length, 0);
});

class MockLLM implements ILLMClient {
  requests: LLMRequest[] = [];
  handler?: (req: LLMRequest) => Promise<LLMResponse> | LLMResponse;

  async generateCode(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push({ ...req });
    if (this.handler) {
      return await this.handler(req);
    }
    return {
      content: '{"text": "Default response", "citedEvidenceIds": []}',
      inputTokens: 100,
      outputTokens: 50,
      attemptCount: 1,
      usageKnown: true,
    };
  }
}

function setupTestEnvironment(capacityLimit = 1) {
  const db = new DatabaseSync(':memory:');
  const agentStore = new AgentStore(db);
  const characterStore = new CharacterStore(agentStore);
  const ledger = new CostLedger(':memory:');
  const capacity = new RunCapacity(capacityLimit);
  const llm = new MockLLM();

  const agent = agentStore.createAgent({
    id: 'agent-milo',
    name: 'Milo',
    model_id: 'deepseek/deepseek-chat',
    fallback_model_id: 'gpt-4o-mini',
    system_prompt: 'You are Milo.',
    budget_cap_usd: 100,
    current_status: 'IDLE',
  });

  const previewService = new CharacterPreviewService({
    agentStore,
    characterStore,
    capacity,
    ledger,
    llm,
    defaultTimeoutMs: 120_000,
  });

  return { db, agentStore, characterStore, ledger, capacity, llm, agent, previewService };
}

test('preview owns a non-scheduled run and releases capacity', async () => {
  const { agentStore, capacity, llm, agent, previewService } = setupTestEnvironment(1);

  // 1. Successful pass
  llm.handler = (req) => {
    if (req.userPrompt?.includes('composing an unsent preview response')) {
      return {
        content: JSON.stringify({ text: 'Design is about making everyday life smoother.', citedEvidenceIds: [] }),
        inputTokens: 120,
        outputTokens: 40,
        attemptCount: 1,
        usageKnown: true,
      };
    }
    // Review call
    return {
      content: JSON.stringify({
        verdict: 'pass',
        scores: { voice: 4, fit: 5, consistency: 4 },
        findings: [],
        extracted: { claims: [], stances: [], relations: [] },
      }),
      inputTokens: 200,
      outputTokens: 60,
      attemptCount: 1,
      usageKnown: true,
    };
  };

  assert.equal(capacity.used, 0);

  const result = await previewService.preview({
    agentId: agent.id,
    situation: { type: 'post', about: 'design and apps' },
  });

  assert.equal(capacity.used, 0, 'capacity must be released on success');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.candidateText, 'Design is about making everyday life smoother.');
  assert.equal(result.semanticState, 'passed');
  assert.ok(result.runId);

  const run = agentStore.getTaskRun(result.runId);
  assert.ok(run);
  assert.equal(run.status, 'COMPLETED');
  assert.equal(run.routine_id, null, 'preview run must have no routineId (non-scheduled)');
  assert.equal(run.agent_id, agent.id);

  // Amendment A3: verify NO CHARACTER_* or ENGAGEMENT_READ event was emitted
  const events = agentStore.getTaskEvents(result.runId);
  assert.ok(events.length > 0, 'events should exist');
  for (const ev of events) {
    assert.ok(!ev.event_type.startsWith('CHARACTER_'), `event ${ev.event_type} must not start with CHARACTER_`);
    assert.notEqual(ev.event_type, 'ENGAGEMENT_READ');
  }

  // 2. Valid inspection with revise findings: completes as COMPLETED in task_runs but never claims pass
  llm.handler = (req) => {
    if (req.userPrompt?.includes('composing an unsent preview response')) {
      return {
        content: JSON.stringify({ text: 'Something off voice here, deliberately long enough for the free length check.', citedEvidenceIds: [] }),
        inputTokens: 100,
        outputTokens: 30,
        attemptCount: 1,
        usageKnown: true,
      };
    }
    return {
      content: JSON.stringify({
        verdict: 'revise',
        scores: { voice: 2, fit: 3, consistency: 3 },
        findings: [{ code: 'OFF_VOICE', severity: 'block', reason: 'Tone is wrong' }],
        extracted: { claims: [], stances: [], relations: [] },
      }),
      inputTokens: 180,
      outputTokens: 50,
      attemptCount: 1,
      usageKnown: true,
    };
  };

  const reviseResult = await previewService.preview({
    agentId: agent.id,
    situation: { type: 'post', about: 'tone test' },
  });

  assert.equal(capacity.used, 0);
  assert.equal(reviseResult.ok, false, 'content must not be claimed to pass');
  assert.equal(reviseResult.review?.verdict, 'revise');
  assert.equal(reviseResult.semanticState, 'failed');

  const reviseRun = agentStore.getTaskRun(reviseResult.runId);
  assert.ok(reviseRun);
  assert.equal(reviseRun.status, 'COMPLETED', 'valid inspection with revise completes task run as an inspection');
});

test('busy capacity refuses without a queued runnable orphan', async () => {
  const { agentStore, capacity, agent, previewService } = setupTestEnvironment(1);

  // Occupy capacity slot
  const releaseOccupant = capacity.acquire('occupant-run-1');
  assert.ok(releaseOccupant);
  assert.equal(capacity.used, 1);

  let caughtError: any = null;
  try {
    await previewService.preview({
      agentId: agent.id,
      situation: { type: 'post', about: 'busy test' },
    });
  } catch (err) {
    caughtError = err;
  }

  assert.ok(caughtError, 'must throw on busy capacity');
  assert.equal(caughtError.code, 'CharacterBusy');
  assert.equal(caughtError.status, 409);
  assert.ok(caughtError instanceof CharacterBusyError);

  // Assert NO queued runnable orphan in agentStore
  const queued = agentStore.queuedTaskRuns();
  assert.equal(queued.length, 0, 'queuedTaskRuns must remain empty');

  // And no runs created for Milo
  const runs = agentStore.listTaskRuns(agent.id);
  assert.equal(runs.length, 0, 'no task run row should have been created on refusal');

  // Cleanup
  releaseOccupant();
  assert.equal(capacity.used, 0);
});

test('request abort and timeout terminate and preserve charged usage', async () => {
  const { agentStore, capacity, llm, agent, previewService } = setupTestEnvironment(1);

  // Part A: Request abort between compose and review
  const ac = new AbortController();
  let composeCalled = false;

  llm.handler = async (req) => {
    if (!composeCalled) {
      composeCalled = true;
      return {
        content: JSON.stringify({ text: 'Valid candidate text, long enough to reach the review call.', citedEvidenceIds: [] }),
        inputTokens: 150,
        outputTokens: 40,
        attemptCount: 1,
        usageKnown: true,
      };
    }
    // For review call, abort before responding
    ac.abort(new Error('User aborted request'));
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    throw abortErr;
  };

  let abortError: any = null;
  try {
    await previewService.preview({
      agentId: agent.id,
      situation: { type: 'post', about: 'abort test' },
      signal: ac.signal,
    });
  } catch (err) {
    abortError = err;
  }

  assert.ok(abortError, 'must throw when aborted');
  assert.equal(capacity.used, 0, 'capacity must be released on abort');

  // Find the created run
  const runs = agentStore.listTaskRuns(agent.id);
  assert.equal(runs.length, 1);
  const abortedRun = runs[0];
  assert.equal(abortedRun.status, 'ABORTED');
  assert.ok(abortedRun.actual_cost_usd >= 0, 'charged usage must be preserved');

  // Part B: Timeout terminates and releases capacity
  const slowLLM = new MockLLM();
  slowLLM.handler = async () => {
    await new Promise((r) => setTimeout(r, 100));
    return {
      content: JSON.stringify({ text: 'Slow candidate', citedEvidenceIds: [] }),
      inputTokens: 100,
      outputTokens: 50,
      attemptCount: 1,
      usageKnown: true,
    };
  };

  const timeoutService = new CharacterPreviewService({
    agentStore,
    characterStore: new CharacterStore(agentStore),
    capacity,
    ledger: new CostLedger(':memory:'),
    llm: slowLLM,
    defaultTimeoutMs: 25,
  });

  let timeoutError: any = null;
  try {
    await timeoutService.preview({
      agentId: agent.id,
      situation: { type: 'post', about: 'timeout test' },
      timeoutMs: 25,
    });
  } catch (err) {
    timeoutError = err;
  }

  assert.ok(timeoutError, 'must throw on timeout');
  assert.equal(capacity.used, 0, 'capacity must be released on timeout');

  const allRuns = agentStore.listTaskRuns(agent.id);
  const timeoutRun = allRuns.find(run => run.id !== abortedRun.id)!;
  assert.equal(timeoutRun.status, 'ABORTED');
});

test('unsaved drafts leave versions sources and Description unchanged', async () => {
  const { agentStore, characterStore, capacity, agent, previewService } = setupTestEnvironment(1);

  // Set original description
  agentStore.updateAgent(agent.id, {
    system_prompt: 'You are an original description that must remain unchanged.',
  });

  const originalDoc = characterStore.getLatestVersion(agent.id);
  assert.equal(originalDoc, null);
  const originalSources = characterStore.getSources(agent.id);
  assert.equal(originalSources.length, 0);

  // Preview with unsaved draft document, settings, and draft sources
  const result = await previewService.preview({
    agentId: agent.id,
    situation: { type: 'post', about: 'unsaved draft' },
    draft: {
      document: {
        identity: {
          name: 'Draft Milo',
          languages: ['en'],
          timezone: 'Asia/Riyadh',
        },
        voice: { rules: { do: ['Be witty and concise.'] } },
      },
      sources: [
        {
          handle: 'draft:source-1',
          kind: 'interview-answer',
          text: 'This is draft source material that should not be saved.',
        },
      ],
    },
  });

  assert.ok(result.runId);
  assert.equal(capacity.used, 0);

  // Verify persistence is UNCHANGED
  const updatedAgent = agentStore.getAgent(agent.id);
  assert.equal(updatedAgent?.system_prompt, 'You are an original description that must remain unchanged.');
  assert.equal(characterStore.getLatestVersion(agent.id), null, 'no character version should be saved');
  assert.equal(characterStore.getSources(agent.id).length, 0, 'no sources should be persisted');
});

test('cancelled or stale responses cannot complete another preview', async () => {
  const { agentStore, capacity, agent } = setupTestEnvironment(2);

  // Preview 1 is aborted while in flight
  const ac1 = new AbortController();
  let resolvePreview1: ((val: LLMResponse) => void) | undefined;
  const preview1Promise = new Promise<LLMResponse>((res) => {
    resolvePreview1 = res;
  });

  let callCount = 0;
  const mockLLM = new MockLLM();
  mockLLM.handler = (req) => {
    callCount++;
    if (callCount === 1) {
      return preview1Promise;
    }
    if (!req.userPrompt?.includes('composing an unsent preview response')) return {
      content: JSON.stringify({ verdict: 'pass', scores: { voice: 4, fit: 4, consistency: 4 }, findings: [],
        extracted: { claims: [], stances: [], relations: [] } }), inputTokens: 100, outputTokens: 50,
      attemptCount: 1, usageKnown: true,
    };
    return {
      content: JSON.stringify({ text: 'Preview 2 candidate', citedEvidenceIds: [] }),
      inputTokens: 100,
      outputTokens: 50,
      attemptCount: 1,
      usageKnown: true,
    };
  };

  const twoSlotService = new CharacterPreviewService({
    agentStore,
    characterStore: new CharacterStore(agentStore),
    capacity,
    ledger: new CostLedger(':memory:'),
    llm: mockLLM,
  });

  // Start preview 1
  const p1 = twoSlotService.preview({
    agentId: agent.id,
    situation: { type: 'post', about: 'call 1' },
    signal: ac1.signal,
    runId: 'preview-run-1',
  });

  // Abort preview 1
  ac1.abort(new Error('Preview 1 cancelled'));
  await assert.rejects(p1);

  const run1 = agentStore.getTaskRun('preview-run-1');
  assert.equal(run1?.status, 'ABORTED');

  // Now start preview 2
  const p2 = await twoSlotService.preview({
    agentId: agent.id,
    situation: { type: 'post', about: 'call 2' },
    runId: 'preview-run-2',
  });

  assert.equal(p2.runId, 'preview-run-2');
  const run2 = agentStore.getTaskRun('preview-run-2');
  assert.equal(run2?.status, 'COMPLETED');

  // Now the stale late response for preview 1 finally arrives
  if (resolvePreview1) {
    resolvePreview1({
      content: JSON.stringify({ text: 'Late response for 1', citedEvidenceIds: [] }),
      inputTokens: 100,
      outputTokens: 50,
      attemptCount: 1,
      usageKnown: true,
    });
  }
  await new Promise((r) => setTimeout(r, 20));

  // Run 1 must stay ABORTED and Run 2 must remain COMPLETED and unaltered
  const finalRun1 = agentStore.getTaskRun('preview-run-1');
  assert.equal(finalRun1?.status, 'ABORTED', 'Run 1 must remain ABORTED after late response');
  const finalRun2 = agentStore.getTaskRun('preview-run-2');
  assert.equal(finalRun2?.status, 'COMPLETED', 'Run 2 must not be affected by late response from 1');
});
