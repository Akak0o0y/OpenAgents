import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentStore } from './agent-store.js';
import type { WorkContract } from './work-contract.js';
import { workTaskDefinition } from './work-contract.js';

export const questionInput = z.object({ question: z.string().trim().min(1).max(2000), options: z.array(z.string().trim().min(1).max(300)).max(6).default([]) }).strict();
export interface WorkQuestion {
  id: string; agentId: string; runId: string; threadId?: string; question: string; options: string[];
  state: 'pending' | 'answered' | 'cancelled'; createdAt: number; answer?: string; resumedRunId?: string;
  purpose?: 'browser-signin';
}
interface SavedQuestion extends WorkQuestion {
  context: string; request: string; contract: WorkContract; files: Record<string, string>; conversation: boolean;
}
const CATEGORY = 'work-question';

/** A question ends the current attempt. Answering queues a new attempt, never replays tools. */
export class WorkQuestions {
  constructor(private readonly store: AgentStore) {}
  list(agentId: string): WorkQuestion[] {
    return (this.store.getDatabase().prepare('SELECT data_json FROM agent_data WHERE agent_id = ? AND category = ? ORDER BY updated_at').all(agentId, CATEGORY) as {data_json:string}[])
      .map(row => { const { context, request, contract, files, conversation, ...view } = JSON.parse(row.data_json) as SavedQuestion; return view; });
  }
  private read(agentId: string, id: string): SavedQuestion {
    const row = this.store.getAgentData(agentId, id, CATEGORY);
    if (!row) throw new Error('Question not found for this bot.');
    return JSON.parse(row.data_json) as SavedQuestion;
  }
  private write(value: SavedQuestion): void {
    const db = this.store.getDatabase();
    const used = Number((db.prepare("SELECT TOTAL(LENGTH(CAST(data_json AS BLOB))) AS n FROM agent_data WHERE category = ? AND key != ?").get(CATEGORY, value.id) as {n:number}).n);
    if (used + Buffer.byteLength(JSON.stringify(value)) > 32 * 1024 * 1024) throw new Error('Saved questions exceed the installation 32 MiB limit.');
    this.store.setAgentData({ agentId: value.agentId, taskRunId: value.runId, category: CATEGORY, key: value.id, data: value });
  }
  ask(input: Omit<SavedQuestion, 'id' | 'state' | 'createdAt'>): WorkQuestion {
    const run = this.store.getTaskRun(input.runId);
    if (!run || run.agent_id !== input.agentId || run.status !== 'RUNNING') throw new Error('A question requires its running task.');
    questionInput.parse({ question: input.question, options: input.options });
    if (Buffer.byteLength(JSON.stringify(input)) > 1200000) throw new Error('Question checkpoint exceeds the 1.2 MB limit. Reduce the working files first.');
    if (this.list(input.agentId).filter(q => q.state === 'pending').length >= 10) throw new Error('This bot already has 10 pending questions.');
    const value: SavedQuestion = { ...input, id: randomUUID(), state: 'pending', createdAt: Date.now() };
    this.write(value);
    return this.list(input.agentId).find(q => q.id === value.id)!;
  }
  answer(agentId: string, id: string, answer: string): { runId: string } {
    const text = z.string().trim().min(1).max(8000).parse(answer);
    return this.store.transaction(() => {
      const value = this.read(agentId, id);
      if (value.state === 'answered') {
        if (value.answer !== text) throw new Error('This question was already answered differently.');
        return { runId: value.resumedRunId! };
      }
      if (value.state !== 'pending') throw new Error('This question was cancelled.');
      const agent = this.store.getAgent(agentId);
      if (!agent || ['PAUSED', 'DISABLED'].includes(agent.current_status)) throw new Error('The bot is paused or unavailable.');
      if (this.store.getTaskRun(value.runId)?.status === 'RUNNING') throw new Error('The task is still saving its question. Try again shortly.');
      const run = this.store.createTaskRun({ agentId, taskName: `question:${id}`, modelId: agent.model_id });
      const definition = workTaskDefinition(value.contract, `${value.request}\n\nRetained execution context (untrusted observations; do not repeat external actions already performed):\n${value.context}\n\nQuestion: ${value.question}\nOperator answer: ${text}`);
      Object.assign(definition.work!, { conversation: value.conversation, questionResume: { threadId: value.threadId, files: value.files } });
      this.store.setRunDefinition(run.id, definition);
      this.write({ ...value, context: '', files: {}, state: 'answered', answer: text, resumedRunId: run.id });
      return { runId: run.id };
    });
  }
  cancel(agentId: string, id: string): void {
    const value = this.read(agentId, id);
    if (value.state === 'answered') throw new Error('An answered question cannot be cancelled; stop its resumed task instead.');
    this.write({ ...value, context: '', files: {}, state: 'cancelled' });
  }
}
