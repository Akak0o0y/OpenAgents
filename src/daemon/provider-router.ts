/**
 * Provider Router & Rate Limit Manager
 * Direct product of the 429 investigation.
 * Owns:
 * - Discriminates 429 reasons: account-level daily quota vs upstream endpoint capacity.
 * - Extracts X-RateLimit-Reset and limit_source from OpenRouter error metadata.
 * - Manages cooldown windows (daily resets vs exponential backoff).
 * - Implements the primary-to-secondary fallback ladder.
 * - Never retries a daily account quota that resets at midnight.
 */

import { PROVISIONAL_CONFIG } from './config.js';

export type RateLimitCategory =
  | 'DAILY_ACCOUNT_QUOTA'
  | 'CREDIT_EXHAUSTED'
  | 'UPSTREAM_ENDPOINT_SATURATED'
  | 'TRANSIENT_ERROR'
  | 'UNKNOWN';

export interface ProviderCooldownState {
  modelId: string;
  isAvailable: boolean;
  category?: RateLimitCategory;
  cooldownUntilMs: number;
  reason?: string;
  limitSource?: string;
  consecutiveErrors: number;
}

export interface SchedulingDecision {
  allowed: boolean;
  modelToUse: string;
  waitMs?: number;
  reason?: string;
  fallbackEngaged: boolean;
}

export class ProviderRouter {
  private states: Map<string, ProviderCooldownState> = new Map();
  private primaryModel: string;

  constructor(primaryModel: string = PROVISIONAL_CONFIG.PRIMARY_MODEL) {
    this.primaryModel = primaryModel;
  }

  /**
   * Check if a model can be dispatched right now.
   * Explicitly avoids silent fallback: substitution is strictly opt-in per agent.
   * If the model is cooling down and no opt-in fallback is permitted/available,
   * returns allowed: false as a legitimate terminal/pause state.
   */
  canSchedule(
    preferredModel: string = this.primaryModel,
    optInFallbackModel?: string | null
  ): SchedulingDecision {
    const now = Date.now();
    const primaryState = this.getOrCreateState(preferredModel);

    // 1. Check if preferred model is free of cooldown
    if (primaryState.cooldownUntilMs <= now) {
      return {
        allowed: true,
        modelToUse: preferredModel,
        fallbackEngaged: false,
      };
    }

    // 2. Preferred model is cooling down. Check explicit opt-in fallback ONLY if configured
    if (optInFallbackModel) {
      const fallbackState = this.getOrCreateState(optInFallbackModel);
      if (fallbackState.cooldownUntilMs <= now) {
        return {
          allowed: true,
          modelToUse: optInFallbackModel,
          fallbackEngaged: true,
          reason: `Preferred model ${preferredModel} is on cooldown until ${new Date(primaryState.cooldownUntilMs).toISOString()} (${primaryState.reason}). Opt-in fallback engaged to ${optInFallbackModel}.`,
        };
      }
    }

    // Preferred model unavailable (and no available opt-in fallback)
    const waitMs = Math.max(0, primaryState.cooldownUntilMs - now);
    return {
      allowed: false,
      modelToUse: preferredModel,
      waitMs,
      fallbackEngaged: false,
      reason: optInFallbackModel
        ? `Both preferred model (${preferredModel}) and opt-in fallback (${optInFallbackModel}) on cooldown. Preferred wait: ${(waitMs / 1000).toFixed(1)}s (${primaryState.reason}).`
        : `Model (${preferredModel}) is on cooldown until ${new Date(primaryState.cooldownUntilMs).toISOString()} (${primaryState.reason}). No fallback configured; pausing dispatch.`,
    };
  }

  /**
   * Record successful call to reset error streaks.
   */
  recordSuccess(modelId: string): void {
    const state = this.getOrCreateState(modelId);
    state.isAvailable = true;
    state.consecutiveErrors = 0;
    state.cooldownUntilMs = 0;
    state.category = undefined;
    state.reason = undefined;
  }

  /**
   * Record an API error and classify its rate-limit signature.
   */
  recordError(modelId: string, status: number, rawBody: string): ProviderCooldownState {
    const state = this.getOrCreateState(modelId);
    state.consecutiveErrors++;
    const now = Date.now();

    let category: RateLimitCategory = 'UNKNOWN';
    let cooldownMs = 10_000 * Math.min(6, Math.pow(2, state.consecutiveErrors - 1)); // default exponential backoff
    let reason = `HTTP ${status}`;
    let limitSource: string | undefined;

    try {
      const parsed = JSON.parse(rawBody);
      const errorObj = parsed.error ?? {};
      const metadata = errorObj.metadata ?? {};
      limitSource = metadata.limit_source;

      // 1. Check for Daily Free-Tier Account Quota
      if (
        limitSource === 'openrouter_free_tier_daily' ||
        errorObj.message?.includes('free-models-per-day')
      ) {
        category = 'DAILY_ACCOUNT_QUOTA';
        // Parse X-RateLimit-Reset (epoch timestamp ms)
        const resetHeader = metadata.headers?.['X-RateLimit-Reset'];
        if (resetHeader) {
          const resetEpoch = Number(resetHeader);
          if (!isNaN(resetEpoch) && resetEpoch > now) {
            cooldownMs = resetEpoch - now;
          }
        } else {
          // Default to 12 hours if reset header missing
          cooldownMs = 12 * 60 * 60 * 1000;
        }
        reason = `Daily Account Quota Exhausted: ${errorObj.message}`;
      }
      // 2. Check for Credit Exhaustion
      else if (status === 402 || limitSource === 'openrouter_credits' || errorObj.code === 402) {
        category = 'CREDIT_EXHAUSTED';
        cooldownMs = 24 * 60 * 60 * 1000; // 24 hours until operator tops up
        reason = `Credit Exhaustion: ${errorObj.message}`;
      }
      // 3. Upstream Provider Capacity
      else if (status === 429 || status === 503) {
        category = 'UPSTREAM_ENDPOINT_SATURATED';
        cooldownMs = 15_000 * Math.min(4, state.consecutiveErrors);
        reason = `Upstream Capacity Throttling: ${errorObj.message ?? 'Too Many Requests'}`;
      }
    } catch {
      // Non-JSON response
      if (status === 429) {
        category = 'UPSTREAM_ENDPOINT_SATURATED';
        cooldownMs = 30_000;
      }
    }

    state.isAvailable = false;
    state.category = category;
    state.cooldownUntilMs = now + cooldownMs;
    state.reason = reason;
    state.limitSource = limitSource;

    return state;
  }

  private getOrCreateState(modelId: string): ProviderCooldownState {
    let state = this.states.get(modelId);
    if (!state) {
      state = {
        modelId,
        isAvailable: true,
        cooldownUntilMs: 0,
        consecutiveErrors: 0,
      };
      this.states.set(modelId, state);
    }
    return state;
  }

  getStates(): ProviderCooldownState[] {
    return Array.from(this.states.values());
  }
}
