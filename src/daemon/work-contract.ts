import { STANDING_BENCHMARKS } from '../kernel/standing-tenant.js';
import type { TaskDefinition } from './scheduler.js';
import { z } from 'zod';
import { workspacePath } from './artifacts.js';

export interface WorkContract extends TaskDefinition {
  id: string;
  kind?: 'code' | 'report' | 'plan';
  name: string;
  description: string;
  requirements: string[];
  /** Operator-selected source files; test fixtures remain immutable. */
  writableFiles?: string[];
  /** Work on a public GitHub repository snapshot instead of fixed fixture files. */
  repository?: RepositoryWorkTarget;
  /** Execution runtime container: node (default) or python. */
  runtime?: 'node' | 'python';
}

export interface RepositoryWorkTarget {
  snapshotKey?: string;
  paths?: string[];
  workingTree?: boolean;
  owner: string;
  repo: string;
  ref: string;
  /** Pinned when the work is defined, so every attempt and verification uses the same files. */
  commit?: string | null;
  /** Omitted means detect from package.json or requirements.txt. */
  install?: 'npm' | 'pip' | 'none';
}

export const RepositoryWorkSchema = z.object({
  agentId: z.string().min(1),
  repository: z.string().trim().min(3).max(300),
  request: z.string().trim().min(1).max(8000),
  testCommand: z.string().trim().min(1).max(2000),
  install: z.enum(['auto', 'npm', 'pip', 'none']).default('auto'),
  paths: z.array(z.string().min(1).max(200)).min(1).max(100).optional(),
  workingTree: z.boolean().optional(),
}).strict();

/** An operator-defined change to a public repository: tested in isolation, delivered as a reviewable patch, never published. */
export function repositoryWorkContract(target: { owner: string; repo: string; ref: string; commit?: string | null }, testCommand: string, install: 'auto' | 'npm' | 'pip' | 'none', request: string, runtime?: 'node' | 'python'): WorkContract {
  const slug = `${target.owner}-${target.repo}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return {
    id: `repository-${slug}`, kind: 'code', name: `Repository change: ${target.owner}/${target.repo}`,
    description: 'Change a public GitHub repository snapshot in an isolated workspace and deliver a tested, reviewable patch. Nothing is published.',
    requirements: [`Address the request: ${request.slice(0, 1000)}`, `The fixed test command must pass: ${testCommand}`, 'Deliver only the changed files and a unified patch; publish nothing.'],
    initialFiles: {}, testCommand, maxTurns: 80, timeoutMs: 1_800_000,
    repository: { owner: target.owner, repo: target.repo, ref: target.ref, commit: target.commit ?? null, ...(install === 'auto' ? {} : { install }) },
    ...(runtime ? { runtime } : {}),
  };
}

/** Step limits: flexible autonomous limits (up to 60 steps for chat/routines/code, 80 steps for repo work). */
export function turnLimit(contract: Pick<WorkContract, 'repository' | 'kind' | 'maxTurns'>, input?: { conversation?: boolean; scheduled?: unknown }): number {
  if (contract.repository) return Math.min(contract.maxTurns ?? 80, 80);
  if (contract.kind === 'code') return Math.min(contract.maxTurns ?? 60, 60);
  if (input?.scheduled) return Math.min(contract.maxTurns ?? 60, 60);
  if (input?.conversation && !input.scheduled) return Math.min(contract.maxTurns ?? 60, 60);
  if (contract.kind === 'report' || contract.kind === 'plan') return Math.min(contract.maxTurns ?? 60, 60);
  return Math.min(contract.maxTurns ?? 60, 60);
}

export const CustomContractSchema = z.object({
  id: z.string().regex(/^custom-[a-z0-9-]{1,50}$/), kind: z.literal('code').default('code'),
  name: z.string().min(1).max(100), description: z.string().min(1).max(2000),
  requirements: z.array(z.string().min(1).max(1000)).min(1).max(30),
  initialFiles: z.record(z.string().max(64000)), writableFiles: z.array(z.string()).min(1).max(16),
  testCommand: z.string().min(1).max(2000), maxTurns: z.number().int().min(1).max(80).default(24),
  timeoutMs: z.number().int().min(1000).max(180000).default(180000),
}).strict().superRefine((c, ctx) => {
  try {
    for (const p of [...Object.keys(c.initialFiles), ...c.writableFiles]) workspacePath(p);
    if (Object.keys(c.initialFiles).length > 28 || JSON.stringify(c.initialFiles).length > 60000) throw new Error('Contract fixture exceeds its context limit.');
    if (new Set(c.writableFiles).size !== c.writableFiles.length) throw new Error('Duplicate writable file.');
    if (c.writableFiles.some(p => !/^src\/.+\.(js|json|ts|tsx|jsx|py|md)$/.test(p))) throw new Error('Writable files must be source files under src/.');
    if (!Object.keys(c.initialFiles).some(p => !c.writableFiles.includes(p) && p !== 'package.json')) throw new Error('Supply immutable acceptance fixtures.');
  } catch (error) { ctx.addIssue({ code: 'custom', message: String(error instanceof Error ? error.message : error) }); }
});

/** Publish supported, satisfiable tasks. Adversarial benchmarks are never product tasks. */
export const DIRECT_WORK_CONTRACTS: WorkContract[] = STANDING_BENCHMARKS
  .filter(task => task.tier === 'easy')
  .map(task => ({ id: task.id, name: task.name, description: task.description, requirements: task.requirements,
    initialFiles: { ...task.initialFiles, 'REQUIREMENTS.md': [task.description, ...task.requirements].join('\n') },
    testCommand: task.testCommand, protectedFiles: ['REQUIREMENTS.md'], maxTurns: 24,
    timeoutMs: 180_000 }));

DIRECT_WORK_CONTRACTS.unshift(
  { id: 'activity-digest', kind: 'report', name: 'Local activity digest', description: 'Summarize a timestamped local OpenAgents activity snapshot and identify recorded items that need an operator decision.',
    requirements: ['Report the snapshot window and distinguish completed, failed and active work.', 'List pending approvals, waiting missions and routine problems as decisions only when they appear in the snapshot.', 'Every finding cites an exact quote from the captured snapshot.', 'Do not claim filesystem, GitHub or external-service changes that the snapshot did not inspect.', 'State when no activity or decision is recorded.'],
    initialFiles: {}, testCommand: '', maxTurns: 24, timeoutMs: 180_000 },
  { id: 'evidence-brief', kind: 'report', name: 'Source-based report', description: 'Summarize supplied material and permitted tool results into a report with checked source quotations.',
    requirements: ['Every finding cites an exact quote from captured source text.', 'State uncertainty and missing information.', 'Deliver a readable report, structured findings and source evidence.'],
    initialFiles: {}, testCommand: '', maxTurns: 24, timeoutMs: 180_000 },
  { id: 'action-plan', kind: 'plan', name: 'Action plan and daily summary', description: 'Turn goals and supplied context into a prioritized plan with acceptance conditions and dependencies.',
    requirements: ['Use unique task IDs and acyclic dependencies.', 'Give every task an observable completion condition.', 'Use explicit timezone offsets for dates; do not invent deadlines.', 'List assumptions and limitations.'],
    initialFiles: {}, testCommand: '', maxTurns: 24, timeoutMs: 180_000 },
);

export function findWorkContract(id: string): WorkContract | undefined {
  return DIRECT_WORK_CONTRACTS.find(contract => contract.id === id);
}

/** The ordinary chat entry point can answer or use tools without selecting a product task template. */
export const CONVERSATION_CONTRACT: WorkContract = {
  id: 'conversation', kind: 'report', name: 'Conversation', description: 'Answer the operator or perform bounded research with captured evidence.',
  requirements: ['Use available tools for requested actions.', 'Report only actions actually performed.'],
  initialFiles: {}, testCommand: '', maxTurns: 60, timeoutMs: 900_000,
};

/**
 * The default routine: do what its instruction says, with tools, and answer.
 *
 * Routines used to require one of the structured contracts, so "every hour,
 * find new AI papers" could only become a cited report - or, picked from a
 * list by mistake, a summary of OpenAgents' own activity. An instruction is now
 * run as a conversation turn, with tools.
 */
export const ROUTINE_ASK_TASK = 'routine:ask';
export const ROUTINE_ASK_CONTRACT: WorkContract = {
  ...CONVERSATION_CONTRACT,
  id: 'routine-ask',
  name: 'Follow the routine instruction',
  // A routine that says "post this" is not carried out by describing what would have been
  // posted. One run drafted a tweet, reported "could not post to X", and was recorded as
  // COMPLETED - a green run that achieved nothing, which is worse than a red one.
  description: 'Carry out a scheduled instruction with the available tools and answer with the result. '
    + 'If the instruction was to DO something - post, send, buy, upload, change - then writing about it is not doing it. '
    + 'When something blocks you, such as a sign-in wall or a missing account, ask the operator to clear it with '
    + 'request_human and continue; if it cannot be cleared, end with block and say what stopped you. '
    + 'Answer as completed only when the thing you were asked to do has actually happened.',
  maxTurns: 60,
  timeoutMs: 900_000,
};

/** Registered task names are explicit, avoiding collisions with legacy benchmark executors. */
export function workTaskDefinition(contract: WorkContract, request: string, sourceOrigin?: string): TaskDefinition {
  return { initialFiles: contract.initialFiles, testCommand: contract.testCommand,
    work: { contract: structuredClone(contract), request, ...(sourceOrigin ? { sourceOrigin } : {}) } };
}
