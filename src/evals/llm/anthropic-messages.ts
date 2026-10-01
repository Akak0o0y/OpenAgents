/**
 * Translate Anthropic Messages SSE events into StreamChunks.
 *
 * Adapted from deepseek-ai/deepseek-harness (packages/llm/llm-deepseek/src/protocols/messages/translate.ts)
 * Upstream commit: 0d1f50007f9bca3f52b06e1c3074fa14d5fb0720
 * Copyright (c) 2026 DeepSeek, MIT License.
 */

import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from './stream.js';
import { ProviderCallError } from '../llm-client.js';

interface BlockState {
  index: number;
  content: ContentBlock;
  closed: boolean;
}

export function stopReason(raw: unknown): FinishReason {
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return { kind: 'stop' };
    case 'tool_use':
      return { kind: 'tool-calls' };
    case 'max_tokens':
      return { kind: 'max-tokens' };
    default:
      return { kind: 'stop' };
  }
}

export async function* translateAnthropicMessages(
  payloads: AsyncIterable<string>
): AsyncGenerator<StreamChunk> {
  const blocks = new Map<number, BlockState>();
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let reason: FinishReason | undefined;

  for await (const payload of payloads) {
    let event: any;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }

    if (event.type === 'error') {
      const msg = event.error?.message || 'Anthropic stream error';
      throw new ProviderCallError('HTTP_ERROR', `Anthropic error: ${msg}`);
    }

    if (event.type === 'message_start') {
      const msgUsage = event.message?.usage;
      if (msgUsage) {
        usage.inputTokens = Number(msgUsage.input_tokens ?? 0);
        if (msgUsage.cache_read_input_tokens !== undefined) {
          usage.cacheReadTokens = Number(msgUsage.cache_read_input_tokens);
        }
        if (msgUsage.cache_creation_input_tokens !== undefined) {
          usage.cacheWriteTokens = Number(msgUsage.cache_creation_input_tokens);
        }
      }
      continue;
    }

    if (event.type === 'content_block_start') {
      const idx = Number(event.index ?? blocks.size);
      const native = event.content_block ?? {};
      let blockContent: ContentBlock;

      if (native.type === 'text') {
        const text = String(native.text ?? '');
        blockContent = { type: 'text', text };
        blocks.set(idx, { index: idx, content: blockContent, closed: false });
        yield { type: 'block-start', index: idx, blockType: 'text' };
        if (text) yield { type: 'text-delta', index: idx, text };
      } else if (native.type === 'thinking') {
        const text = String(native.thinking ?? '');
        blockContent = { type: 'reasoning', text };
        blocks.set(idx, { index: idx, content: blockContent, closed: false });
        yield { type: 'block-start', index: idx, blockType: 'reasoning' };
        if (text) yield { type: 'reasoning-delta', index: idx, text };
      } else if (native.type === 'tool_use') {
        const id = String(native.id ?? `call-${idx}`);
        const name = String(native.name ?? '');
        blockContent = { type: 'tool-call', id, name, arguments: '' };
        blocks.set(idx, { index: idx, content: blockContent, closed: false });
        yield { type: 'block-start', index: idx, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: idx, id, name, argumentsDelta: '' };
      }
    } else if (event.type === 'content_block_delta') {
      const idx = Number(event.index);
      const block = blocks.get(idx);
      if (!block || block.closed) continue;
      const delta = event.delta ?? {};

      if (delta.type === 'text_delta' && block.content.type === 'text') {
        const text = String(delta.text ?? '');
        block.content.text += text;
        yield { type: 'text-delta', index: idx, text };
      } else if (delta.type === 'thinking_delta' && block.content.type === 'reasoning') {
        const text = String(delta.thinking ?? '');
        block.content.text += text;
        yield { type: 'reasoning-delta', index: idx, text };
      } else if (delta.type === 'input_json_delta' && block.content.type === 'tool-call') {
        const frag = String(delta.partial_json ?? '');
        block.content.arguments += frag;
        yield { type: 'tool-call-delta', index: idx, id: block.content.id, argumentsDelta: frag };
      }
    } else if (event.type === 'content_block_stop') {
      const idx = Number(event.index);
      const block = blocks.get(idx);
      if (block && !block.closed) {
        block.closed = true;
        yield { type: 'block-end', index: idx, block: { ...block.content } };
      }
    } else if (event.type === 'message_delta') {
      if (event.delta?.stop_reason) {
        reason = stopReason(event.delta.stop_reason);
      }
      if (event.usage?.output_tokens !== undefined) {
        usage.outputTokens = Number(event.usage.output_tokens);
      }
    } else if (event.type === 'message_stop') {
      for (const block of blocks.values()) {
        if (!block.closed) {
          block.closed = true;
          yield { type: 'block-end', index: block.index, block: { ...block.content } };
        }
      }
      usage.totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      yield { type: 'usage', usage };
      yield { type: 'finish', reason: reason ?? { kind: 'stop' } };
      return;
    }
  }

  // End of stream if message_stop was missing
  for (const block of blocks.values()) {
    if (!block.closed) {
      block.closed = true;
      yield { type: 'block-end', index: block.index, block: { ...block.content } };
    }
  }
  usage.totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  yield { type: 'usage', usage };
  yield { type: 'finish', reason: reason ?? { kind: 'stop' } };
}
