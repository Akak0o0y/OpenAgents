/**
 * Translate OpenAI-compatible / OpenRouter / DeepSeek chat completion SSE streams into StreamChunks.
 *
 * Adapted from deepseek-ai/deepseek-harness (packages/llm/llm-deepseek/src/protocols/chat-completions/translate.ts)
 * Upstream commit: 0d1f50007f9bca3f52b06e1c3074fa14d5fb0720
 * Copyright (c) 2026 DeepSeek, MIT License.
 */

import { DONE } from './sse.js';
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from './stream.js';
import { ProviderCallError } from '../llm-client.js';

interface OpenBlock {
  index: number;
  kind: 'text' | 'reasoning' | 'tool-call';
  text: string;
  callId?: string;
  name?: string;
}

export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop':
      return { kind: 'stop' };
    case 'tool_calls':
      return { kind: 'tool-calls' };
    case 'length':
    case 'max_tokens':
    case 'MAX_TOKENS':
      return { kind: 'max-tokens' };
    default:
      return { kind: 'stop' };
  }
}

export function mapUsage(usage: any): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  const promptTokens = Number(usage.prompt_tokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? 0);
  return {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    totalTokens: Number(usage.total_tokens ?? (promptTokens + completionTokens)),
    ...(cacheRead !== undefined ? { cacheReadTokens: Number(cacheRead) } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: Number(reasoning) } : {}),
  };
}

function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'reasoning':
      return { type: 'reasoning', text: block.text };
    case 'tool-call':
      return {
        type: 'tool-call',
        id: block.callId ?? `call-${block.index}`,
        name: block.name ?? '',
        arguments: block.text,
      };
  }
}

export async function* translateChatCompletions(
  payloads: AsyncIterable<string>
): AsyncGenerator<StreamChunk> {
  let nextIndex = 0;
  let textBlock: OpenBlock | undefined;
  let reasoningBlock: OpenBlock | undefined;
  const toolBlocks = new Map<number, OpenBlock>();
  const order: OpenBlock[] = [];
  let pendingFinish: FinishReason | undefined;
  let pendingUsage: TokenUsage | undefined;
  let firstModel: string | undefined;

  function open(kind: OpenBlock['kind']): OpenBlock {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' };
    order.push(block);
    return block;
  }

  for await (const payload of payloads) {
    if (payload === DONE) {
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) };
      }
      if (pendingUsage) {
        yield { type: 'usage', usage: pendingUsage };
      }
      yield {
        type: 'finish',
        reason: pendingFinish ?? { kind: 'stop' },
        ...(firstModel ? { model: firstModel } : {}),
      };
      return;
    }

    let chunk: any;
    try {
      chunk = JSON.parse(payload);
    } catch {
      // Non-JSON payload that is not DONE; skip or ignore
      continue;
    }

    if (chunk.error) {
      const msg = typeof chunk.error === 'string' ? chunk.error : chunk.error.message || 'Stream error';
      throw new ProviderCallError('HTTP_ERROR', `Stream returned provider error: ${msg}`);
    }

    if (!firstModel && typeof chunk.model === 'string' && chunk.model.trim()) {
      firstModel = chunk.model.trim();
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      if (!delta) continue;

      // Reasoning delta (DeepSeek R1 / OpenRouter / reasoning_content or reasoning)
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning');
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' };
        }
        reasoningBlock.text += reasoning;
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning };
      }

      // Content delta
      const content = delta.content;
      if (typeof content === 'string' && content.length > 0) {
        if (!textBlock) {
          textBlock = open('text');
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' };
        }
        textBlock.text += content;
        yield { type: 'text-delta', index: textBlock.index, text: content };
      }

      // Tool calls
      for (const call of delta.tool_calls ?? []) {
        const idx = call.index ?? 0;
        let block = toolBlocks.get(idx);
        if (!block) {
          block = open('tool-call');
          toolBlocks.set(idx, block);
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
        }
        if (call.id) block.callId = call.id;
        if (call.function?.name) block.name = call.function.name;
        const argFrag = call.function?.arguments ?? '';
        block.text += argFrag;
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: block.callId,
          name: block.name,
          argumentsDelta: argFrag,
        };
      }

      if (typeof choice.finish_reason === 'string') {
        pendingFinish = mapFinishReason(choice.finish_reason);
      }
    }

    if (chunk.usage) {
      pendingUsage = mapUsage(chunk.usage);
    }
  }

  // If stream ended without literal [DONE], flush what we have
  for (const block of order) {
    yield { type: 'block-end', index: block.index, block: closeBlock(block) };
  }
  if (pendingUsage) {
    yield { type: 'usage', usage: pendingUsage };
  }
  yield {
    type: 'finish',
    reason: pendingFinish ?? { kind: 'stop' },
    ...(firstModel ? { model: firstModel } : {}),
  };
}
