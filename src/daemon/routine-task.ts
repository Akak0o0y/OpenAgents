import { workTaskDefinition } from './work-contract.js';
import type { RoutineRecord } from './db/schema.js';
import type { TaskDefinition } from './scheduler.js';

/** Refuses a routine that could never run: it must name a registered task with its own verification. */
export function routineBindingError(taskName: unknown, registered: (name: string) => TaskDefinition | undefined, available: Array<{ id: string; name: string }>): string | null {
  const choices = available.map(task => `work:${task.id} (${task.name})`).join(', ');
  if (typeof taskName !== 'string' || !taskName.trim()) return `A routine needs a task with its own verification; a prompt alone cannot run. Choose one of: ${choices}.`;
  if (!registered(taskName)) return `Routine task "${taskName}" is not registered. Choose one of: ${choices}.`;
  return null;
}

/** A prompt alone cannot supply independent acceptance criteria. */
export function routineTaskDefinition(routine: RoutineRecord, registered?: TaskDefinition, context?: { request: string; sourceOrigin: string }): TaskDefinition {
  if (routine.task_name && registered?.work) {
    const definition = workTaskDefinition(registered.work.contract, context?.request ?? routine.prompt_template, context?.sourceOrigin);
    // An "ask the bot" routine runs its instruction as a conversation turn, with tools.
    if (registered.work.conversation) definition.work!.conversation = true;
    return definition;
  }
  if (routine.task_name && registered) {
    return { ...registered, initialFiles: { ...registered.initialFiles, 'PROMPT.md': routine.prompt_template } };
  }
  return {
    initialFiles: { 'PROMPT.md': routine.prompt_template },
    testCommand: '',
    unsupportedReason: routine.task_name
      ? `Routine task "${routine.task_name}" is not registered.`
      : 'This routine needs a registered task with objective-specific verification. General prompt execution is not available yet; no model was called.',
  };
}
