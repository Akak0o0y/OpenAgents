/**
 * Stream protocol types and BlockAssembler for LLM streaming.
 *
 * Adapted from deepseek-ai/deepseek-harness (packages/llm/llm/src/assembler.ts and types.ts)
 * Upstream commit: 0d1f50007f9bca3f52b06e1c3074fa14d5fb0720
 * Copyright (c) 2026 DeepSeek, MIT License.
 */

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ReasoningBlock {
  type: 'reasoning';
  text: string;
}

export interface ToolCallBlock {
  type: 'tool-call';
  id: string;
  name: string;
  arguments: string;
}

export type ContentBlock = TextBlock | ReasoningBlock | ToolCallBlock;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface FinishReason {
  kind: 'stop' | 'tool-calls' | 'max-tokens' | 'error';
  failure?: { message: string; code?: string };
}

export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: 'text' | 'reasoning' | 'tool-call' }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id?: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; model?: string }
  | { type: 'error'; error: any; code?: string };

interface PartialBlock {
  blockType: 'text' | 'reasoning' | 'tool-call';
  text: string;
  toolCallId?: string;
  toolCallName?: string;
  toolCallArguments: string;
  block?: ContentBlock;
}

/**
 * Incrementally assembles raw StreamChunks into ContentBlocks, text, reasoning,
 * and token usage.
 */
export class BlockAssembler {
  private partials = new Map<number, PartialBlock>();
  private order: number[] = [];
  private _usage: TokenUsage | undefined;
  private _finish: FinishReason | undefined;
  private _model: string | undefined;

  push(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'block-start': {
        if (!this.partials.has(chunk.index)) {
          this.order.push(chunk.index);
          this.partials.set(chunk.index, {
            blockType: chunk.blockType,
            text: '',
            toolCallArguments: '',
          });
        }
        return;
      }
      case 'text-delta':
      case 'reasoning-delta': {
        const partial = this.ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning');
        if (partial.block) return; // closed by block-end; ignore stragglers
        partial.text += chunk.text;
        return;
      }
      case 'tool-call-delta': {
        const partial = this.ensure(chunk.index, 'tool-call');
        if (partial.block) return;
        if (chunk.id) partial.toolCallId = chunk.id;
        if (chunk.name) partial.toolCallName = chunk.name;
        partial.toolCallArguments += chunk.argumentsDelta;
        return;
      }
      case 'block-end': {
        const partial = this.ensure(chunk.index, chunk.block.type);
        if (partial.block) return;
        partial.block = chunk.block;
        return;
      }
      case 'usage': {
        this._usage = chunk.usage;
        return;
      }
      case 'finish': {
        this._finish = chunk.reason;
        if (chunk.model) this._model = chunk.model;
        return;
      }
      case 'error': {
        this._finish = { kind: 'error', failure: { message: String(chunk.error?.message ?? chunk.error), code: chunk.code } };
        return;
      }
    }
  }

  private ensure(index: number, blockType: 'text' | 'reasoning' | 'tool-call'): PartialBlock {
    let partial = this.partials.get(index);
    if (!partial) {
      partial = { blockType, text: '', toolCallArguments: '' };
      this.partials.set(index, partial);
      this.order.push(index);
    }
    return partial;
  }

  private assemble(partial: PartialBlock, index: number): ContentBlock {
    if (partial.block) return partial.block;
    switch (partial.blockType) {
      case 'text':
        return { type: 'text', text: partial.text };
      case 'reasoning':
        return { type: 'reasoning', text: partial.text };
      case 'tool-call':
        return {
          type: 'tool-call',
          id: partial.toolCallId ?? `call-${index}`,
          name: partial.toolCallName ?? '',
          arguments: partial.toolCallArguments,
        };
    }
  }

  blocks(): ContentBlock[] {
    return this.order.map((index) => {
      const partial = this.partials.get(index)!;
      return this.assemble(partial, index);
    });
  }

  text(): string {
    return this.blocks()
      .filter((b): b is TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }

  reasoning(): string {
    return this.blocks()
      .filter((b): b is ReasoningBlock => b.type === 'reasoning')
      .map((b) => b.text)
      .join('');
  }

  get usage(): TokenUsage | undefined {
    return this._usage;
  }

  get finish(): FinishReason {
    return this._finish ?? { kind: 'stop' };
  }

  get model(): string | undefined {
    return this._model;
  }
}
