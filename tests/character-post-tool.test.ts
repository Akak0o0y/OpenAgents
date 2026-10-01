import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/daemon/agent-store.js';
import { CharacterStore } from '../src/daemon/character-store.js';
import { CharacterJournal } from '../src/daemon/character-journal.js';
import { CharacterAdmissions } from '../src/daemon/character-admission.js';
import { CharacterProjector } from '../src/daemon/character-projector.js';
import { CostLedger } from '../src/kernel/cost-ledger.js';
import { ArtifactStore } from '../src/daemon/artifacts.js';
import { WorkRuntime } from '../src/daemon/work-runtime.js';
import { CONVERSATION_CONTRACT } from '../src/daemon/work-contract.js';
import { availableTools } from '../src/daemon/tool-schemas.js';
import { actionSchema, NATIVE_PARALLEL_TOOLS } from '../src/daemon/work-actions.js';

test('prepare_post is a strict opt-in tool and never a parallel read', () => {
  assert.ok(actionSchema.safeParse({ tool: 'prepare_post', op: 'post', about: 'test' }).success);
  assert.ok(!actionSchema.safeParse({ tool: 'prepare_post', op: 'post', about: 'test', surprise: true }).success);
  assert.ok(availableTools({ canPreparePost: true }).some(t => t.name === 'prepare_post'));
  assert.ok(!availableTools({}).some(t => t.name === 'prepare_post'));
  assert.ok(!NATIVE_PARALLEL_TOOLS.has('prepare_post'));
});
test('real runtime prepares exact owner text with no speaker calls, redacts events and releases admission', async t => {
  const store = new AgentStore(':memory:'); t.after(() => store.close());
  store.createAgent({ id: 'a', name: 'Milo', model_id: 'gpt-4o-mini', budget_cap_usd: 10, current_status: 'IDLE' });
  store.createTaskRun({ id: 'r', agentId: 'a', taskName: 'test', modelId: 'gpt-4o-mini' }); store.startTaskRun('r', 'gpt-4o-mini');
  const characters = new CharacterStore(store);
  characters.save('a', 0, { settings: { mode: 'voice' }, document: { identity: { oneLine: 'A careful writer.' }, purpose: { statement: 'Explain clearly.' },
    voice: { examples: ['One clear example.', 'Another useful observation.', 'A third careful example.'].map((text, i) => ({ id: `ex-${i}`, text, surface: 'post', pinned: i < 2, tags: [], origin: 'owner' })) } } });
  const journal = new CharacterJournal({ store });
  const admissions = new CharacterAdmissions({ store, journal, activeVersion: id => characters.getLatestVersion(id) });
  const projector = new CharacterProjector({ store, journal });
  const text = 'This is the PRIVATE exact message.';
  const calls: any[] = [], policies: any[] = [];
  const llm: any = { generateCode: async (req: any) => {
    calls.push(req); return { content: JSON.stringify(calls.length === 1 ? { tool: 'prepare_post', op: 'post', about: 'PRIVATE about', exact: text } : { tool: 'answer', text: 'Prepared only.', citations: [] }), inputTokens: 10, outputTokens: 5, attemptCount: 1 };
  } };
  const browser: any = { status: () => ({ enabled: true }), waitForOperator: async () => {}, endRun: async () => {},
    setRunPolicy: (_id: string, p: unknown) => policies.push(p), clearRunPolicy: () => {} };
  const runtime = new WorkRuntime({ store, characterStore: characters, characterPosting: { journal, admissions, projector },
    ledger: new CostLedger(store.getDatabase()), artifacts: new ArtifactStore(store), llm, browser, sandbox: {} as any });
  const result = await runtime.execute({ taskRunId: 'r', contract: CONVERSATION_CONTRACT, request: `Prepare these words: ${text}`,
    conversation: true, signal: new AbortController().signal });
  assert.equal(result.outcome, 'COMPLETED'); assert.equal(calls.length, 2);
  assert.ok(calls[0].tools?.some((t: any) => t.name === 'prepare_post') || calls[0].systemPrompt.includes('prepare_post'));
  assert.equal(policies[0].character.requireAdmission, false);
  const rows = store.getDatabase().prepare('SELECT payload_json FROM execution_events WHERE event_type IN (\'TOOL_CALL\',\'CHARACTER_COMPOSED\',\'CHARACTER_ADMITTED\')').all();
  assert.ok(JSON.stringify(rows).includes('utteranceId'));
  assert.ok(!JSON.stringify(rows).includes(text)); assert.ok(!JSON.stringify(rows).includes('PRIVATE about'));
  assert.equal(admissions.liveFor('r'), undefined);
});
