/**
 * One-shot live OpenCode run.
 *
 * Runs a single fixture task through the REAL opencode CLI - no stub, no test
 * seam - and prints what actually happened. This is how a model earns the word
 * "capable" in this repo.
 *
 *   npm run opencode:smoke
 *   npm run opencode:smoke -- --model opencode/mimo-v2.5-free
 *   npm run opencode:smoke -- --model nvidia/nemotron-3-super-120b-a12b:free
 *
 * The credential follows the model's provider, so OpenCode Zen models use
 * OPENCODE_API_KEY and are unaffected by the OpenRouter daily quota.
 *
 * Outcomes, by exit code:
 *   0  COMPLETED     - the model implemented it and the hardened verdict container agreed
 *   2  RATE_LIMITED  - provider quota exhausted; the harness itself ran correctly
 *   1  anything else - read the printed session summary
 *
 * A COMPLETED here is the first evidence that a given free model is capable of
 * agentic work. Everything short of that is a statement about the harness, not
 * the model.
 */

import { AgentStore } from './agent-store.js';
import { CostLedger } from '../kernel/cost-ledger.js';
import { OpenCodeExecutor } from './opencode-executor.js';
import { PROVISIONAL_CONFIG } from './config.js';
import { loadEnvFiles, syncOpenRouterCatalog, syncModelsDevCatalog } from '../evals/llm-client.js';
import { requiredCredentialEnvVar, toOpenCodeModel } from './opencode-executor.js';

const FIXTURE_FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'opencode-smoke', type: 'module' }, null, 2),
  'test.js': [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { slugify } from './src/index.js';",
    '',
    "test('lowercases and hyphenates', () => {",
    "  assert.equal(slugify('Hello World'), 'hello-world');",
    '});',
    '',
    "test('strips punctuation and collapses separators', () => {",
    "  assert.equal(slugify('  Wait --- What?! '), 'wait-what');",
    '});',
  ].join('\n'),
  'src/index.js': [
    '// TODO: implement slugify so the tests in test.js pass.',
    'export function slugify(input) {',
    '  return input;',
    '}',
  ].join('\n'),
};

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  loadEnvFiles();
  const model = argValue('--model') ?? PROVISIONAL_CONFIG.OPENCODE_MODEL;
  const envVar = requiredCredentialEnvVar(model);
  if (!process.env[envVar]) {
    console.error(`Fatal: ${envVar} is not set (environment or .env). Model "${model}" needs it.`);
    process.exit(1);
  }

  // Real pricing, so the ledger figures below mean something. Which catalog
  // depends on who hosts the model - OpenCode Zen is not on OpenRouter.
  const provider = toOpenCodeModel(model).split('/')[0];
  let priced: number;
  if (provider === 'openrouter') {
    priced = (await syncOpenRouterCatalog()).count;
  } else {
    const md = await syncModelsDevCatalog();
    priced = md.count;
  }
  console.log(`Catalog: ${priced} models priced (provider ${provider})`);
  console.log(`Model:   ${model}`);
  console.log(`Auth:    ${envVar}`);
  console.log(`Image:   ${PROVISIONAL_CONFIG.OPENCODE_IMAGE}`);
  console.log('Task:    slugify - two assertions, must fail against the stub\n');

  const store = new AgentStore(':memory:');
  const ledger = new CostLedger(':memory:');
  store.createAgent({
    id: 'smoke-agent',
    name: 'Smoke',
    model_id: model,
    budget_cap_usd: PROVISIONAL_CONFIG.DEFAULT_TASK_BUDGET_USD,
    current_status: 'IDLE',
  });
  store.createTaskRun({ agentId: 'smoke-agent', taskName: 'slugify' });
  const taskRun = store.listTaskRuns()[0];

  const executor = new OpenCodeExecutor({ agentStore: store, ledger });

  console.log('Running opencode (this takes a while - it is a full agentic session)...\n');
  const started = Date.now();
  const res = await executor.executeTask({
    agent: store.getAgent('smoke-agent')!,
    taskRun,
    initialFiles: FIXTURE_FILES,
    testCommand: 'node --test test.js',
    timeoutMs: 120_000,
  });

  const session = store.getTaskEvents(taskRun.id).find((e) => e.event_type === 'OPENCODE_SESSION');
  const turn = store.getTaskEvents(taskRun.id).find((e) => e.event_type === 'TURN_COMPLETED');

  console.log('================ RESULT ================');
  console.log(`Outcome:      ${res.outcome}`);
  console.log(`Wall clock:   ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`Cost:         $${res.actualCostUsd.toFixed(6)} (shadow $${res.shadowCostUsd.toFixed(6)})`);
  if (session) {
    const p = JSON.parse(session.payload_json);
    console.log(`Session:      ${p.sessionId ?? '(none)'}`);
    console.log(`Events:       ${p.eventCount} parsed, ${p.unparsedLines} unparsed`);
    console.log(`Usage seen:   ${p.usageReported}`);
    console.log(`Agent exit:   ${p.agentExitCode}  <-- not a success signal, by design`);
    if (p.errors?.length) {
      console.log('Agent errors:');
      for (const e of p.errors) console.log(`  [${e.statusCode ?? '-'}] ${e.name}: ${e.message}`);
    }
  }
  if (turn) {
    const p = JSON.parse(turn.payload_json);
    console.log(`\nVerdict container (network none): exit ${p.testExitCode}`);
    if (p.testOutput) console.log(String(p.testOutput).split('\n').slice(0, 25).join('\n'));
  }
  if (res.errorMessage) console.log(`\nError: ${res.errorMessage}`);
  console.log('=======================================');

  store.close();
  ledger.close();

  if (res.outcome === 'COMPLETED') {
    console.log(`\nVERIFIED: ${model} completed an agentic task under OpenCode.`);
    process.exit(0);
  }
  if (res.outcome === 'RATE_LIMITED') {
    console.log('\nQuota exhausted. The harness ran correctly; retry after the daily reset.');
    process.exit(2);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error('Smoke run crashed:', err);
  process.exit(1);
});
