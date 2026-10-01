import type { AgentStore } from './agent-store.js';
import { createHash } from 'node:crypto';
import type { AgentRecord } from './db/schema.js';
import { parseRepository, type RepositoryFetcher, type RepositoryRef, type RepositorySnapshot } from './repository-snapshot.js';
import { RepositoryWorkSchema, repositoryWorkContract, workTaskDefinition, type WorkContract } from './work-contract.js';

/**
 * Defining repository work: validate the request, pin a public repository snapshot, then queue an isolated run
 * that delivers a tested, reviewable patch. Shared by the operator API and approval-gated chat proposals.
 * Nothing here publishes anything.
 */

export interface PreparedRepositoryWork {
  agent: AgentRecord;
  target: RepositoryRef;
  snapshot: RepositorySnapshot;
  contract: WorkContract;
  request: string;
  testCommand: string;
}

export interface QueuedRepositoryWork {
  runId: string;
  repository: string;
  ref: string;
  commit: string | null;
  textFiles: number;
  skipped: number;
  testCommand: string;
  request: string;
}

/** Validates and downloads the snapshot. Asynchronous, so it runs before any database transaction. */
export async function prepareRepositoryWork(store: AgentStore, repositories: Pick<RepositoryFetcher, 'snapshot'>, input: unknown, signal: AbortSignal): Promise<PreparedRepositoryWork> {
  const value = RepositoryWorkSchema.parse(input);
  const agent = store.getAgent(value.agentId);
  if (!agent) throw new Error('Unknown bot.');
  const target = { ...parseRepository(value.repository), ...(value.paths ? {paths:value.paths} : {}), ...(value.workingTree ? {workingTree:true} : {}) };
  const snapshot = await repositories.snapshot(target, signal);
  if (!snapshot.commit) throw new Error('GitHub did not identify the downloaded commit. No work was queued.');
  const isPython = Object.hasOwn(snapshot.files, 'requirements.txt') || Object.hasOwn(snapshot.files, 'pyproject.toml') || Object.hasOwn(snapshot.files, 'setup.py');
  const runtime: 'node' | 'python' = isPython ? 'python' : 'node';
  // Pin the commit now, so every attempt and verification of this work uses the same files.
  const contract = repositoryWorkContract({ ...target, commit: snapshot.commit }, value.testCommand, value.install, value.request, runtime);
  Object.assign(contract.repository!, {paths:value.paths, workingTree:value.workingTree});
  return { agent, target, snapshot, contract, request: value.request, testCommand: value.testCommand };
}

/** Queues the prepared work for the scheduler. Synchronous, so a caller can include it in its own transaction. */
export function queueRepositoryWork(store: AgentStore, prepared: PreparedRepositoryWork): QueuedRepositoryWork {
  const encoded = JSON.stringify(prepared.snapshot);
  const key = createHash('sha256').update(JSON.stringify({target:prepared.target,commit:prepared.snapshot.commit,bytes:prepared.snapshot.archiveSha256})).digest('hex');
  const used = Number((store.getDatabase().prepare("SELECT TOTAL(LENGTH(CAST(data_json AS BLOB))) AS n FROM agent_data WHERE category='repository-snapshot' AND NOT (agent_id=? AND key=?)").get(prepared.agent.id,key) as {n:number}).n);
  if (used + Buffer.byteLength(encoded) > 512 * 1024 * 1024) throw new Error('Repository snapshots reached the 512 MiB storage limit. Remove old repository runs before importing more.');
  store.setAgentData({agentId:prepared.agent.id,category:'repository-snapshot',key,data:prepared.snapshot});
  prepared.contract.repository!.snapshotKey = key;
  const run = store.createTaskRun({ agentId: prepared.agent.id, taskName: `work:${prepared.contract.id}`, modelId: prepared.agent.model_id });
  store.setRunDefinition(run.id, workTaskDefinition(prepared.contract, prepared.request));
  return {
    runId: run.id,
    repository: `${prepared.target.owner}/${prepared.target.repo}`,
    ref: prepared.target.ref,
    commit: prepared.snapshot.commit,
    textFiles: Object.keys(prepared.snapshot.files).length,
    skipped: prepared.snapshot.skipped.length,
    testCommand: prepared.testCommand,
    request: prepared.request,
  };
}

export async function defineRepositoryWork(store: AgentStore, repositories: Pick<RepositoryFetcher, 'snapshot'>, input: unknown, signal: AbortSignal): Promise<QueuedRepositoryWork> {
  return queueRepositoryWork(store, await prepareRepositoryWork(store, repositories, input, signal));
}
