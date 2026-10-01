import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { AgentStore } from '../dist/src/daemon/agent-store.js';
import { CharacterStore } from '../dist/src/daemon/character-store.js';
import { CostLedger } from '../dist/src/kernel/cost-ledger.js';
import { ArtifactStore } from '../dist/src/daemon/artifacts.js';
import { WorkRuntime } from '../dist/src/daemon/work-runtime.js';
import { CONVERSATION_CONTRACT } from '../dist/src/daemon/work-contract.js';
import { createDefaultCharacterDocument, createDefaultCharacterSettings, SLIDER_LEVEL_1, SLIDER_LEVEL_5 } from '../dist/src/daemon/character-schema.js';
import { compileCharacterPacket } from '../dist/src/daemon/character-compiler.js';
import { checkCharacterRules } from '../dist/src/daemon/character-rules.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--out') throw new Error('Usage: character-probes.mjs --out <owned output directory>. No profile argument is accepted.');
const out = path.resolve(args[1]);
const allowedDoc = path.join(root, 'docs', 'validation', '2026-09-25-character');
const relativeTemp = path.relative(os.tmpdir(), out);
const tempOwned = !relativeTemp.startsWith('..') && !path.isAbsolute(relativeTemp) && /^character-probes-[^\\/]+(?:[\\/]|$)/.test(relativeTemp);
if (/appdata[\\/]roaming[\\/]openhours/i.test(out) || (out !== allowedDoc && !tempOwned)) throw new Error('Refusing unowned output path.');
// Refuse symlink/reparse ancestors, even if the lexical name is allowed.
for (let p = out; p !== path.dirname(p); p = path.dirname(p)) {
  try { if ((await fs.lstat(p)).isSymbolicLink()) throw new Error('Output may not traverse a symbolic link.'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}
await fs.mkdir(out, { recursive: true });
const existing = await fs.readdir(out);
const marker = '.character-probes-v1';
if (existing.length && (!existing.includes(marker) || existing.some(p => ![marker, 'probes.json', 'probes.md', 'slider-phrases.json'].includes(p)))) {
  throw new Error('Refusing to overwrite unowned output files.');
}
const hash = value => createHash('sha256').update(value).digest('hex');
const doc = createDefaultCharacterDocument('Milo');
doc.identity.oneLine = 'A careful and curious test character.';
doc.purpose.statement = 'Explain software clearly.';
doc.voice.examples = ['Read the evidence before drawing conclusions.', 'A small clear function is easier to test.', 'Show what changed and why it matters.'].map((text, i) =>
  ({ id: `example-${i}`, text, surface: 'post', pinned: i < 2, tags: ['software'], origin: 'owner' }));
const settings = createDefaultCharacterSettings(); settings.mode = 'character';
const packets = [];
for (const mode of ['off', 'voice', 'character']) for (const surface of ['owner-chat', 'public-compose', 'task-loop', 'code']) {
  const packet = compileCharacterPacket({ document: doc, settings: { ...settings, mode }, surface, query: 'software', seed: 'fixture', asOf: '2026-09-25T00:00:00.000Z' });
  const limit = mode === 'off' || surface === 'code' ? 0 : surface === 'task-loop' ? 320 : surface === 'owner-chat' ? (mode === 'voice' ? 1000 : 1600) : (mode === 'voice' ? 1120 : 2500);
  packets.push({ mode, surface, stableLimit: limit, stableChars: packet.meta.stableChars, dataChars: packet.meta.dataChars,
    stableSha256: packet.meta.stableSha256, selectionSha256: packet.meta.selectionSha256 ?? null, omissions: packet.meta.omissions });
}
const histories = [];
for (const priorTurns of [8, 40, 80]) {
  const store = new AgentStore(':memory:');
  try {
    const characters = new CharacterStore(store), ledger = new CostLedger(store.getDatabase());
    const agent = store.createAgent({ id: 'probe', name: 'Milo', model_id: 'gpt-4o-mini', budget_cap_usd: 100, current_status: 'IDLE' });
    characters.save(agent.id, 0, { document: doc, settings });
    const run = store.createTaskRun({ id: 'probe-run', agentId: agent.id, taskName: CONVERSATION_CONTRACT.id }); store.startTaskRun(run.id);
    const calls = [];
    const llm = { generateCode: async request => {
      const compaction = request.systemPrompt.includes('execution history summarizer');
      calls.push({ compaction, identity: request.systemPrompt.includes(doc.identity.oneLine) });
      return { content: compaction ? 'Scripted summary: prior observations retained as test data.' : '{"tool":"answer","text":"Scripted answer only","citations":[]}', inputTokens: 100, outputTokens: 30, attemptCount: 1 };
    } };
    const forbidden = async () => { throw new Error('A probe must never start a sandbox.'); };
    const runtime = new WorkRuntime({ store, characterStore: characters, ledger, llm, artifacts: new ArtifactStore(store),
      sandbox: { createWorkspaceVolume: forbidden, stageWorkspaceFiles: forbidden, readWorkspaceFile: forbidden, executeTask: forbidden, destroyWorkspaceVolume: forbidden } });
    const history = [{ role: 'user', content: 'Original synthetic request.' }];
    for (let i = 0; i < priorTurns; i++) history.push({ role: 'assistant', content: '', toolCalls: [{ id: `old-${i}`, name: 'read', arguments: '{"path":"fixture.txt"}' }] },
      { role: 'tool', toolCallId: `old-${i}`, content: `Fixture observation ${i}: ${'known data '.repeat(500)}`, observation: true });
    const result = await runtime.execute({ taskRunId: run.id, contract: CONVERSATION_CONTRACT, request: 'Summarize the fixture.', conversation: true,
      initialMessages: history, signal: new AbortController().signal });
    histories.push({ priorTurns, logicalCalls: calls.length, compactionCalls: calls.filter(c => c.compaction).length,
      identityPreserved: calls.filter(c => !c.compaction).every(c => c.identity), outcome: result.outcome });
  } finally { store.close(); }
}
const sourceFiles = ['character-schema', 'character-compiler', 'character-recall', 'character-store', 'character-rules', 'character-speaker', 'character-preview', 'character-api', 'one-shot-call', 'work-runtime'];
const sourceHashes = {};
const compiledHashes = {};
for (const name of sourceFiles) {
  sourceHashes[name] = hash((await fs.readFile(path.join(root, 'src', 'daemon', `${name}.ts`), 'utf8')).replace(/\r\n?/g, '\n'));
  compiledHashes[name] = hash((await fs.readFile(path.join(root, 'dist', 'src', 'daemon', `${name}.js`), 'utf8')).replace(/\r\n?/g, '\n'));
}
const repeated = Array.from({ length: 20 }, () => 'The same synthetic repeated sentence for a deterministic checker fixture.');
const repetition = repeated.slice(1).map(text => checkCharacterRules(text, doc, settings, { retainedConfirmedPosts: [repeated[0]] }).hardPass);
const evidence = { kind: 'character-probes/v1', head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceHashes, compiledHashes, realProviderCalls: 0, packets, histories, repetition: { fixtureCount: 20, duplicateRejections: repetition.filter(pass => !pass).length },
  limitations: ['Scripted fixtures do not establish model quality, independent judgment, real billing or provider caching.',
    '8/40/80 denotes prior scripted conversation/tool exchanges, not 80 new autonomous steps; ordinary runtime steps remain capped at 60.',
    'No browser, Docker, owner profile, publication, installed package or live account was exercised.'] };
await fs.writeFile(path.join(out, marker), 'character-probes/v1\n');
await fs.writeFile(path.join(out, 'probes.json'), JSON.stringify(evidence, null, 2) + '\n');
await fs.writeFile(path.join(out, 'slider-phrases.json'), JSON.stringify({ level1: SLIDER_LEVEL_1, level5: SLIDER_LEVEL_5 }, null, 2) + '\n');
await fs.writeFile(path.join(out, 'probes.md'), '# Phase 1 deterministic character probes\n\n' +
  `Build source: ${evidence.head}; exact source and compiled hashes are in probes.json.\n\n` +
  '| Prior scripted exchanges | Calls | Compactions | Identity preserved | Outcome |\n|---|---|---|---|---|\n' +
  histories.map(h => `| ${h.priorTurns} | ${h.logicalCalls} | ${h.compactionCalls} | ${h.identityPreserved} | ${h.outcome} |`).join('\n') + '\n\n' +
  evidence.limitations.map(s => `- ${s}`).join('\n') + '\n');
process.stdout.write('Character fixture evidence written. No live model or browser calls.\n');
