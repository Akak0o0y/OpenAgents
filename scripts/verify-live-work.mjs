import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfigFile } from '../dist/src/daemon/config-file.js';
import { AgentStore } from '../dist/src/daemon/agent-store.js';
import { CostLedger } from '../dist/src/kernel/cost-ledger.js';
import { DockerSandbox } from '../dist/src/kernel/docker-sandbox.js';
import { WorkRuntime } from '../dist/src/daemon/work-runtime.js';
import { ArtifactStore } from '../dist/src/daemon/artifacts.js';
import { findWorkContract, CustomContractSchema } from '../dist/src/daemon/work-contract.js';
import { LiveLLMClient, syncOpenRouterCatalog } from '../dist/src/evals/llm-client.js';
import { saveWorkResult } from '../dist/src/daemon/work-results.js';

// Opt-in live evidence, synthetic material, exactly the configured model IDs.
const config = loadConfigFile();
const models = [...new Set(config?.config.agents.map(a => a.model) ?? [])];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-live-work-'));
const store = new AgentStore(path.join(root, 'state.db')); const ledger = new CostLedger(store.getDatabase());
const llm = new LiveLLMClient(); const sandbox = new DockerSandbox(undefined, root); const artifacts = new ArtifactStore(store);
const runtime = new WorkRuntime({ store, ledger, llm, sandbox, artifacts });
const evidence = { timestamp: new Date().toISOString(), models, profile: root, results: [] };
const output = process.argv[2] ?? path.join(root, 'evidence.json');
fs.mkdirSync(path.dirname(path.resolve(output)), {recursive:true});
try {
  if (models.some(m => m.includes('/'))) await syncOpenRouterCatalog();
  for (const [index, model] of models.entries()) {
    if (!llm.hasProvider(model)) { evidence.results.push({ model, outcome: 'UNAVAILABLE', reason: 'Configured provider credential is absent.' }); process.exitCode = 1; continue; }
    const agentId = `probe-${index}`;
    store.createAgent({ id: agentId, name: 'Synthetic capability probe', model_id: model, budget_cap_usd: 0.25, current_status: 'IDLE' });
    for (const [id, request] of [
      ['action-plan', 'Plan a small release review. Include two tasks with observable done conditions. Do not invent a deadline.'],
      ['evidence-brief', 'Synthetic source material: Initial testing is finished. Release approval is still pending. Summarize these supplied statements with exact quotes and acknowledge that these are supplied statements only.'],
      ['cli-arg-parser', 'Implement the selected parser contract, verify the original supplied tests and deliver the source files.'],
      ['custom-total', 'Repair the existing total function in the supplied repository snapshot. Cover empty input, negative numbers and input immutability. Run the fixed acceptance tests and deliver the corrected module.'],
    ].filter(([id]) => !process.argv[3] || id === process.argv[3])) {
      const run = store.createTaskRun({ agentId, taskName: `live:${id}`, modelId: model }); store.startTaskRun(run.id);
      const contract = { ...(id === 'custom-total' ? CustomContractSchema.parse(JSON.parse(fs.readFileSync(new URL('../docs/examples/custom-task-contract.json',import.meta.url),'utf8'))) : findWorkContract(id)), maxTurns: 12 };
      const started = performance.now();
      const result = await runtime.execute({ taskRunId: run.id, contract, request, signal: new AbortController().signal });
      saveWorkResult(store, run.id, result);
      store.finishTaskRun(run.id, result.outcome, result.outcome === 'COMPLETED' ? undefined : result.report);
      const record = { model, contract: id, runId: run.id, durationMs:Math.round(performance.now()-started),
        providerEvents:store.getTaskEvents(run.id).filter(e=>e.event_type==='PROVIDER_CALL').map(e=>({turn:e.turn_number,...JSON.parse(e.payload_json)})), ...result };
      if (result.outcome !== 'COMPLETED') process.exitCode = 1;
      evidence.results.push(record); fs.writeFileSync(output, JSON.stringify(evidence, null, 2));
      console.log(JSON.stringify({ model, contract: id, outcome: result.outcome, turns: result.turns, costUsd: result.actualCostUsd }));
      if ((contract.kind ?? 'code') === 'code' && result.outcome === 'COMPLETED') await sandbox.destroyWorkspaceVolume(sandbox.workspaceVolumeName(`task-${run.id}`));
    }
  }
  if (evidence.results.length === 0) { evidence.error = 'No configured model/task pair was tested.'; process.exitCode = 1; }
} catch (error) { evidence.error = String(error.message ?? error); process.exitCode = 1; }
finally { fs.writeFileSync(output, JSON.stringify(evidence, null, 2)); ledger.close(); store.close(); console.log(`Evidence: ${output}`); }
