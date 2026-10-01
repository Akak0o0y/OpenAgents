import type { CostLedger, ConnectionAdmission } from '../kernel/cost-ledger.js';
import { ProviderCallError, type ILLMClient, type LLMResponse, type ChatMessage, type RoutingMode } from '../evals/llm-client.js';
import type { ModelRoute } from './provider-connections.js';

export interface OneShotUsage {
  logicalCalls: number;
  wireAttempts: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: null;
  costUsd: number | null;
  priceKnown: boolean;
  usageKnown: boolean;
}

export interface OneShotAccounting {
  reservationId: string;
  usage: OneShotUsage;
  cost: {
    actualCostUsd: number;
    shadowCostUsd: number;
  };
  status: 'RECONCILED' | 'EXPIRED_UNDISPATCHED' | 'UNRECONCILED_ASSUMED_SPENT';
  servedModel?: string | null;
  error?: unknown;
}

export interface OneShotResult {
  content: string;
  response: LLMResponse;
  usage: OneShotUsage;
  cost: {
    actualCostUsd: number;
    shadowCostUsd: number;
  };
  reservationId: string;
}

export interface OneShotCallOptions {
  ledger: CostLedger;
  llm: ILLMClient;
  taskId: string;
  agentId: string;
  modelId: string;
  budgetCapUsd?: number;
  estimatedTokens?: number;
  ttlSeconds?: number;
  systemPrompt: string;
  userPrompt?: string;
  messages?: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  purpose: string;
  route?: ModelRoute;
  connection?: { id: string; routingMode: RoutingMode };
  admission?: ConnectionAdmission;
  sponsorBudget?: { agentId: string; budgetCapUsd: number } | { sponsorAgentId: string; sponsorBudgetCapUsd: number };
  onAccounting?: (accounting: OneShotAccounting) => void;
  onProviderEvent?: (event: Record<string, unknown>) => void;
  emit?: (type: string, payload: Record<string, unknown>) => void;
}

/**
 * Execute a bounded model call with no tools through the CostLedger reservation and reconciliation path.
 *
 * Extracts and shares the accounting, dispatch, and settlement logic from performCompaction.
 * Used for compaction, learned-flows Stage 2, character speaker compose/review calls, and preview.
 */
export async function oneShotCall(options: OneShotCallOptions): Promise<OneShotResult> {
  const measuredStart=performance.now();
  const measure=(a:OneShotAccounting)=>options.emit?.('MODEL_MEASUREMENT',{schema:'model-measurement/1',callId:a.reservationId,purpose:options.purpose,requestedModel:options.modelId,servedModel:a.servedModel??null,durationMs:performance.now()-measuredStart,status:a.error?'failed':'ok',logicalCalls:1,wireAttempts:a.usage.wireAttempts,inputTokens:a.usage.usageKnown?a.usage.inputTokens:null,outputTokens:a.usage.usageKnown?a.usage.outputTokens:null,encoderTokens:null,cachedInputTokens:null,costUsd:a.usage.costUsd,usageSource:a.usage.usageKnown?(options.route?.connection||options.connection?'gateway':'provider'):'unknown',tokenizer:null});
  if (options.signal?.aborted) {
    throw (options.signal.reason instanceof Error
      ? options.signal.reason
      : new Error(options.signal.reason ? String(options.signal.reason) : 'The operation was aborted'));
  }

  const connection = options.route?.connection ?? options.connection;
  const admission = options.route?.admission ?? options.admission;
  const sponsor = options.sponsorBudget
    ? ('agentId' in options.sponsorBudget
        ? options.sponsorBudget
        : { agentId: options.sponsorBudget.sponsorAgentId, budgetCapUsd: options.sponsorBudget.sponsorBudgetCapUsd })
    : undefined;

  const userPrompt = options.userPrompt ?? (options.messages?.at(-1)?.content ?? '');
  const estTokens = options.estimatedTokens ?? (
    Math.ceil((options.systemPrompt.length + userPrompt.length) / 3) + (options.maxTokens ?? 1500)
  );
  const budgetCap = options.budgetCapUsd ?? 100;

  const reservation = options.ledger.reserveWithBudgetCheck(
    options.taskId,
    options.agentId,
    options.modelId,
    budgetCap,
    estTokens,
    options.ttlSeconds ?? 900,
    admission,
    sponsor
  );
  const reservationId = reservation.id;

  options.ledger.markDispatched(reservationId);

  let lastReportedAttempt: number | null = null;
  const handleProviderEvent = (event: any) => {
    if (event && typeof event.attempt === 'number') {
      lastReportedAttempt = event.attempt;
    }
    const boundedEvent = { ...event, toolMode: 'none', purpose: options.purpose };
    options.onProviderEvent?.(boundedEvent);
    options.emit?.('PROVIDER_CALL', boundedEvent);
  };

  let accounted = false;
  try {
    const pending = options.llm.generateCode({
      modelId: options.modelId,
      systemPrompt: options.systemPrompt,
      userPrompt,
      messages: options.messages,
      tools: undefined,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      signal: options.signal,
      connection,
      onProviderEvent: handleProviderEvent,
    });
    // A provider adapter may ignore AbortSignal. Settle this reservation on
    // cancellation and consume late completion without changing a terminal run.
    let response: LLMResponse;
    if (options.signal) {
      const signal = options.signal;
      let onAbort: () => void = () => {};
      try {
        response = await Promise.race([pending, new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason ?? new Error('The operation was aborted'));
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        })]);
      } finally { signal.removeEventListener('abort', onAbort); }
    } else { response = await pending; }

    const isUsageKnown = response.usageKnown !== false;
    const cost = !isUsageKnown
      ? { actualCostUsd: 0, shadowCostUsd: 0, pricingKnown: false }
      : options.ledger.reconcile(
          reservationId,
          response.inputTokens,
          response.outputTokens,
          { servedModel: response.served?.routedVia }
        );

    if (!isUsageKnown) {
      options.ledger.markUnreconciledAssumedSpent(reservationId);
      options.emit?.('PROVIDER_USAGE_UNKNOWN', { reservationId, purpose: options.purpose });
    }

    accounted = true;
    const wireAttempts = response.attemptCount ?? lastReportedAttempt ?? 1;
    const usage: OneShotUsage = {
      logicalCalls: 1,
      wireAttempts,
      inputTokens: response.inputTokens ?? 0,
      outputTokens: response.outputTokens ?? 0,
      cachedTokens: null,
      costUsd: isUsageKnown && cost.pricingKnown ? cost.actualCostUsd : null,
      priceKnown: isUsageKnown && cost.pricingKnown,
      usageKnown: isUsageKnown,
    };

    const accounting: OneShotAccounting = {
      reservationId,
      usage,
      cost: { actualCostUsd: cost.actualCostUsd, shadowCostUsd: cost.shadowCostUsd },
      status: !isUsageKnown ? 'UNRECONCILED_ASSUMED_SPENT' : 'RECONCILED',
      servedModel: response.served?.routedVia ?? null,
    };

    measure(accounting);options.onAccounting?.(accounting);

    return {
      content: response.content ?? '',
      response,
      usage,
      cost: { actualCostUsd: cost.actualCostUsd, shadowCostUsd: cost.shadowCostUsd },
      reservationId,
    };
  } catch (err) {
    if (reservationId && !accounted) {
      accounted = true;
      let status: 'RECONCILED' | 'EXPIRED_UNDISPATCHED' | 'UNRECONCILED_ASSUMED_SPENT';
      let usage: OneShotUsage;
      let cost = { actualCostUsd: 0, shadowCostUsd: 0 };
      let servedModel: string | null = null;

      if (err instanceof ProviderCallError && err.details?.usage) {
        const u = err.details.usage;
        servedModel = err.details.served?.routedVia ?? null;
        const rec = options.ledger.reconcile(reservationId, u.inputTokens, u.outputTokens, { servedModel });
        cost = { actualCostUsd: rec.actualCostUsd, shadowCostUsd: rec.shadowCostUsd };
        status = 'RECONCILED';
        usage = {
          logicalCalls: 1,
          wireAttempts: err.details.notSent ? 0 : (lastReportedAttempt ?? null),
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cachedTokens: null,
          costUsd: rec.pricingKnown ? rec.actualCostUsd : null,
          priceKnown: rec.pricingKnown,
          usageKnown: true,
        };
      } else if (err instanceof ProviderCallError && err.details?.notSent) {
        options.ledger.releaseUnsent(reservationId);
        status = 'EXPIRED_UNDISPATCHED';
        usage = {
          logicalCalls: 1,
          wireAttempts: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: null,
          costUsd: 0,
          priceKnown: true,
          usageKnown: true,
        };
      } else {
        options.ledger.markUnreconciledAssumedSpent(reservationId);
        status = 'UNRECONCILED_ASSUMED_SPENT';
        usage = {
          logicalCalls: 1,
          wireAttempts: lastReportedAttempt ?? null,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: null,
          costUsd: null,
          priceKnown: false,
          usageKnown: false,
        };
      }

      const accounting: OneShotAccounting = {
        reservationId,
        usage,
        cost,
        status,
        servedModel,
        error: err,
      };

      try {
        measure(accounting);options.onAccounting?.(accounting);
      } catch {
        // Do not let accounting callback error conceal original error
      }
    }
    throw err;
  }
}
