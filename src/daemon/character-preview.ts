import { randomUUID } from 'node:crypto';
import type { AgentStore } from './agent-store.js';
import type { CharacterStore, SaveCharacterOptions } from './character-store.js';
import type { RunCapacity } from './run-capacity.js';
import type { CostLedger } from '../kernel/cost-ledger.js';
import type { ILLMClient } from '../evals/llm-client.js';
import type { ProviderRouter } from './provider-router.js';
import { modelRoute, type ProviderConnectionService } from './provider-connections.js';
import { oneShotCall, type OneShotUsage } from './one-shot-call.js';
import { previewCharacterSpeaker, resolveReviewer, TryItSituationSchema, type CharacterSpeakerPreviewResult } from './character-speaker.js';
import { CharacterBusyError, CharacterInvalidError, CharacterNotFoundError, createDefaultCharacterDocument, createDefaultCharacterSettings,
  mergeCharacterDocument, mergeCharacterSettings, validateCharacterDocument, validateCharacterSettings, validateDraftSourceEnvelope, CHARACTER_SCHEMA_VERSION } from './character-schema.js';
import { checkCharacterDocumentFit } from './character-compiler.js';

/** Pure authoring view: source handles are local to this request, never persisted. */
export function prepareCharacterDraft(store: AgentStore, characters: CharacterStore, agentId: string, draft: SaveCharacterOptions = {}) {
  const agent = store.getAgent(agentId);
  if (!agent) throw new CharacterNotFoundError('Bot not found.');
  const latest = characters.getLatestVersion(agentId);
  if (latest && (latest.schema_version !== CHARACTER_SCHEMA_VERSION || latest.document.schema !== CHARACTER_SCHEMA_VERSION)) {
    throw new CharacterInvalidError('This character uses an unsupported schema version.');
  }
  const sources = (draft.sources ?? []).map(validateDraftSourceEnvelope);
  if (new Set(sources.map(s => s.handle)).size !== sources.length) throw new CharacterInvalidError('Duplicate draft source handle.');
  const settings = validateCharacterSettings(mergeCharacterSettings(latest?.settings ?? createDefaultCharacterSettings(), draft.settings ?? {}));
  const document = validateCharacterDocument(mergeCharacterDocument(latest?.document ?? createDefaultCharacterDocument(agent.name), draft.document ?? {}), settings.mode);
  if (settings.mode !== 'off') checkCharacterDocumentFit(document, settings.mode);
  for (const example of document.voice.examples) {
    if (example.sourceId && !sources.some(s => s.handle === example.sourceId) && !characters.getSource(agentId, example.sourceId)) {
      throw new CharacterInvalidError('Example source is missing or belongs to another bot.');
    }
  }
  return { agent, document, settings, sources, version: latest?.version ?? 0 };
}

export interface CharacterPreviewResult extends CharacterSpeakerPreviewResult {
  runId: string;
  usage: OneShotUsage;
}

export class CharacterPreviewService {
  constructor(private readonly options: {
    agentStore: AgentStore; characterStore: CharacterStore; capacity: RunCapacity; ledger: CostLedger; llm: ILLMClient;
    providerRouter?: ProviderRouter; connections?: ProviderConnectionService; defaultTimeoutMs?: number;
  }) {}

  async preview(input: { agentId: string; situation: unknown; draft?: SaveCharacterOptions; signal?: AbortSignal;
    timeoutMs?: number; runId?: string; origin?: 'studio' }): Promise<CharacterPreviewResult> {
    const { agentStore: store, characterStore, capacity, ledger, llm } = this.options;
    input.signal?.throwIfAborted();
    const situation = TryItSituationSchema.parse(input.situation);
    const { agent, document, settings } = prepareCharacterDraft(store, characterStore, input.agentId, input.draft);
    const reviewer = resolveReviewer(agent, settings);
    const routeFor = (modelId: string, connectionId: string | null, explicit: boolean) => {
      if (connectionId && this.options.connections) {
        const connection = this.options.connections.list().find(c => c.id === connectionId);
        if (!connection?.enabled || !connection.hasKey || !connection.catalog.models.some(m => m.id === modelId && m.usable !== false)) {
          throw new CharacterInvalidError('The selected model connection is unavailable.');
        }
      }
      const route = modelRoute(store, { ...agent, model_id: modelId, connection_id: connectionId,
        routing_mode: explicit ? 'pinned' : agent.routing_mode });
      if (this.options.providerRouter && !this.options.providerRouter.canSchedule(route.key).allowed) {
        throw new CharacterBusyError('The selected model is temporarily unavailable.');
      }
      return route;
    };
    // Fail invalid explicit configuration before spending on the author call.
    routeFor(agent.model_id, agent.connection_id ?? null, false);
    routeFor(reviewer.modelId, reviewer.connectionId, !!settings.checks.reviewer);
    const runId = input.runId ?? `character-preview-${Date.now()}-${randomUUID()}`;
    if (store.getTaskRun(runId)) throw new CharacterInvalidError('Preview run already exists.');
    const release = capacity.acquire(runId);
    if (!release) throw new CharacterBusyError('All work slots are busy. Try again when one is free.');
    const controller = new AbortController();
    const abort = () => controller.abort(input.signal?.reason ?? new Error('Preview cancelled.'));
    input.signal?.addEventListener('abort', abort, { once: true });
    const timeoutMs = Math.min(input.timeoutMs ?? this.options.defaultTimeoutMs ?? 120_000, 120_000);
    const timeout = setTimeout(() => controller.abort(new Error('Preview timed out.')), Math.max(1, timeoutMs));
    const usage: OneShotUsage = { logicalCalls: 0, wireAttempts: 0, inputTokens: 0, outputTokens: 0,
      cachedTokens: null, costUsd: 0, priceKnown: true, usageKnown: true };
    let actual = 0, shadow = 0;
    let callFailure = false;
    try {
      // No await between creation and start: the scheduler must never see a queued preview.
      store.createTaskRun({ id: runId, agentId: agent.id, taskName: 'Character preview (unsent)', modelId: agent.model_id });
      store.startTaskRun(runId, agent.model_id, { executor: 'character-preview', origin: input.origin ?? 'studio' });
      const result = await previewCharacterSpeaker({ agent, doc: document, settings, situation, signal: controller.signal,
        asOf: new Date(store.getTaskRun(runId)!.started_at!).toISOString(), seed: runId,
        oneShotCall: async params => {
          controller.signal.throwIfAborted();
          if (usage.logicalCalls >= 2) throw new CharacterInvalidError('Preview call limit reached.');
          const reviewing = params.purpose === 'preview-review';
          const route = routeFor(params.model, reviewing ? reviewer.connectionId : agent.connection_id ?? null,
            reviewing && !!settings.checks.reviewer);
          try {
            const response = await oneShotCall({ ledger, llm, taskId: runId, agentId: agent.id, modelId: params.model,
              budgetCapUsd: agent.budget_cap_usd, route, systemPrompt: params.systemPrompt, userPrompt: params.userPrompt,
              maxTokens: params.maxTokens, signal: controller.signal, purpose: params.purpose,
              onAccounting: accounting => {
                const u = accounting.usage;
                usage.logicalCalls += u.logicalCalls;
                usage.wireAttempts = usage.wireAttempts === null || u.wireAttempts === null ? null : usage.wireAttempts + u.wireAttempts;
                usage.inputTokens += u.inputTokens; usage.outputTokens += u.outputTokens;
                usage.costUsd = usage.costUsd === null || u.costUsd === null ? null : usage.costUsd + u.costUsd;
                usage.priceKnown &&= u.priceKnown; usage.usageKnown &&= u.usageKnown;
                actual += accounting.cost.actualCostUsd; shadow += accounting.cost.shadowCostUsd;
                store.updateTaskRunProgress(runId, usage.logicalCalls, actual, shadow);
              } });
            controller.signal.throwIfAborted();
            return { text: response.content, attemptCount: response.usage.wireAttempts ?? undefined,
              usage: { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens,
                totalTokens: response.usage.inputTokens + response.usage.outputTokens } };
          } catch (error) { callFailure = true; throw error; }
        } });
      controller.signal.throwIfAborted();
      const failed = callFailure || !!result.error || result.semanticState.startsWith('unchecked-');
      store.finishTaskRun(runId, failed ? 'FAILED' : 'COMPLETED', failed ? 'Preview could not be checked.' : undefined,
        { executor: 'character-preview', unsent: true, semanticState: result.semanticState });
      return { ...result, runId, usage, logicalCalls: usage.logicalCalls, wireAttempts: usage.wireAttempts,
        totalTokens: usage.inputTokens + usage.outputTokens };
    } catch (error) {
      if (store.getTaskRun(runId)?.status === 'RUNNING') {
        store.finishTaskRun(runId, controller.signal.aborted ? 'ABORTED' : 'FAILED',
          controller.signal.aborted ? 'Preview cancelled or timed out.' : 'Preview failed.');
      }
      throw error;
    } finally {
      clearTimeout(timeout); input.signal?.removeEventListener('abort', abort); release();
    }
  }
}
