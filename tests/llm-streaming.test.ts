import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseSse, DONE } from '../src/evals/llm/sse.js';
import { translateChatCompletions } from '../src/evals/llm/chat-completions.js';
import { translateAnthropicMessages } from '../src/evals/llm/anthropic-messages.js';
import { BlockAssembler, type StreamChunk } from '../src/evals/llm/stream.js';
import { LiveLLMClient, ProviderCallError, type ConnectionResolver } from '../src/evals/llm-client.js';
import { LiveChannel, type RunLiveFrame } from '../src/daemon/live-stream.js';

function stringToReadableStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe('Phase 1c: Streamed Text and Reasoning (Streaming Transport)', () => {
  describe('parseSse', () => {
    it('parses basic SSE events and stops at [DONE]', async () => {
      const stream = stringToReadableStream([
        'data: {"id":"1"}\n\n',
        ': comment line\n',
        'data: {"id":"2"}\n\n',
        'data: [DONE]\n\n',
      ]);

      const events: string[] = [];
      for await (const event of parseSse(stream)) {
        events.push(event);
      }

      assert.deepEqual(events, ['{"id":"1"}', '{"id":"2"}', DONE]);
    });

    it('joins multi-line data payloads with newline and handles CRLF', async () => {
      const stream = stringToReadableStream([
        'data: part 1\r\ndata: part 2\r\n\r\n',
        'data: final\r\n\r\n',
      ]);

      const events: string[] = [];
      for await (const event of parseSse(stream)) {
        events.push(event);
      }

      assert.deepEqual(events, ['part 1\npart 2', 'final']);
    });

    it('enforces 2 MiB stream cap and throws INVALID_RESPONSE', async () => {
      const bigPayload = 'data: ' + 'A'.repeat(1024 * 1024) + '\n\n';
      const stream = stringToReadableStream([
        bigPayload,
        bigPayload,
        bigPayload, // 3 MiB total
      ]);

      await assert.rejects(
        async () => {
          for await (const _ of parseSse(stream)) {}
        },
        (err: any) => {
          assert.ok(err instanceof ProviderCallError);
          assert.equal(err.code, 'INVALID_RESPONSE');
          assert.match(err.message, /2 MiB limit/);
          return true;
        }
      );
    });

    it('aborts and throws CANCELLED when abort signal triggers', async () => {
      const controller = new AbortController();
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async pull(ctrl) {
          ctrl.enqueue(encoder.encode('data: chunk\n\n'));
          controller.abort();
        },
      });

      await assert.rejects(
        async () => {
          for await (const _ of parseSse(stream, controller.signal)) {}
        },
        (err: any) => {
          assert.ok(err instanceof ProviderCallError);
          assert.equal(err.code, 'CANCELLED');
          return true;
        }
      );
    });
  });

  describe('translateChatCompletions', () => {
    it('translates content deltas and finish reason', async () => {
      async function* generatePayloads() {
        yield JSON.stringify({
          id: 'chat-1',
          model: 'deepseek-chat',
          choices: [{ delta: { content: 'Hello' } }],
        });
        yield JSON.stringify({
          id: 'chat-1',
          model: 'deepseek-chat',
          choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
        yield DONE;
      }

      const chunks: StreamChunk[] = [];
      for await (const chunk of translateChatCompletions(generatePayloads())) {
        chunks.push(chunk);
      }

      assert.ok(chunks.some((c) => c.type === 'block-start' && c.blockType === 'text'));
      assert.ok(chunks.some((c) => c.type === 'text-delta' && c.text === 'Hello'));
      assert.ok(chunks.some((c) => c.type === 'text-delta' && c.text === ' world'));
      assert.ok(chunks.some((c) => c.type === 'block-end'));
      const finishChunk = chunks.find((c) => c.type === 'finish');
      assert.ok(finishChunk && finishChunk.type === 'finish');
      assert.equal(finishChunk.reason.kind, 'stop');
      assert.equal(finishChunk.model, 'deepseek-chat');

      const usageChunk = chunks.find((c) => c.type === 'usage');
      assert.ok(usageChunk && usageChunk.type === 'usage');
      assert.equal(usageChunk.usage.inputTokens, 10);
      assert.equal(usageChunk.usage.outputTokens, 5);
    });

    it('translates reasoning deltas (reasoning_content and reasoning)', async () => {
      async function* generatePayloads() {
        yield JSON.stringify({
          choices: [{ delta: { reasoning_content: 'Let me think...' } }],
        });
        yield JSON.stringify({
          choices: [{ delta: { reasoning: ' Step 2.' } }],
        });
        yield JSON.stringify({
          choices: [{ delta: { content: '42' }, finish_reason: 'stop' }],
        });
        yield DONE;
      }

      const chunks: StreamChunk[] = [];
      for await (const chunk of translateChatCompletions(generatePayloads())) {
        chunks.push(chunk);
      }

      const reasoningDeltas = chunks.filter((c) => c.type === 'reasoning-delta');
      assert.equal(reasoningDeltas.length, 2);
      assert.equal((reasoningDeltas[0] as any).text, 'Let me think...');
      assert.equal((reasoningDeltas[1] as any).text, ' Step 2.');
    });

    it('translates tool call deltas', async () => {
      async function* generatePayloads() {
        yield JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call-1', function: { name: 'web_search', arguments: '{"q":' } },
                ],
              },
            },
          ],
        });
        yield JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '"ai news"}' } }],
              },
            },
          ],
        });
        yield DONE;
      }

      const chunks: StreamChunk[] = [];
      for await (const chunk of translateChatCompletions(generatePayloads())) {
        chunks.push(chunk);
      }

      const toolDeltas = chunks.filter((c) => c.type === 'tool-call-delta');
      assert.equal(toolDeltas.length, 2);
      assert.equal((toolDeltas[0] as any).name, 'web_search');
      assert.equal((toolDeltas[0] as any).argumentsDelta, '{"q":');
      assert.equal((toolDeltas[1] as any).argumentsDelta, '"ai news"}');
    });

    it('throws ProviderCallError on mid-stream error payload', async () => {
      async function* generatePayloads() {
        yield JSON.stringify({
          error: { message: 'Upstream rate limit mid-stream' },
        });
      }

      await assert.rejects(
        async () => {
          for await (const _ of translateChatCompletions(generatePayloads())) {}
        },
        (err: any) => {
          assert.ok(err instanceof ProviderCallError);
          assert.equal(err.code, 'HTTP_ERROR');
          assert.match(err.message, /Upstream rate limit mid-stream/);
          return true;
        }
      );
    });
  });

  describe('translateAnthropicMessages', () => {
    it('translates Anthropic thinking and text deltas', async () => {
      async function* generatePayloads() {
        yield JSON.stringify({
          type: 'message_start',
          message: { model: 'claude-3-7-sonnet-20250219', usage: { input_tokens: 25 } },
        });
        yield JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        });
        yield JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Analyzing query...' },
        });
        yield JSON.stringify({
          type: 'content_block_stop',
          index: 0,
        });
        yield JSON.stringify({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        });
        yield JSON.stringify({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'Hello Claude' },
        });
        yield JSON.stringify({
          type: 'content_block_stop',
          index: 1,
        });
        yield JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 15 },
        });
        yield JSON.stringify({
          type: 'message_stop',
        });
      }

      const chunks: StreamChunk[] = [];
      for await (const chunk of translateAnthropicMessages(generatePayloads())) {
        chunks.push(chunk);
      }

      const thinkingDelta = chunks.find((c) => c.type === 'reasoning-delta');
      assert.ok(thinkingDelta && (thinkingDelta as any).text === 'Analyzing query...');

      const textDelta = chunks.find((c) => c.type === 'text-delta');
      assert.ok(textDelta && (textDelta as any).text === 'Hello Claude');

      const finish = chunks.find((c) => c.type === 'finish');
      assert.ok(finish && (finish as any).reason.kind === 'stop');
    });
  });

  describe('BlockAssembler', () => {
    it('assembles text, reasoning, and handles ignored stragglers after block-end', () => {
      const assembler = new BlockAssembler();

      assembler.push({ type: 'block-start', index: 0, blockType: 'reasoning' });
      assembler.push({ type: 'reasoning-delta', index: 0, text: 'Thinking step 1.' });
      assembler.push({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Thinking step 1.' } });
      // Straggler delta after block-end should be ignored
      assembler.push({ type: 'reasoning-delta', index: 0, text: ' Ignored straggler' });

      assembler.push({ type: 'block-start', index: 1, blockType: 'text' });
      assembler.push({ type: 'text-delta', index: 1, text: 'Answer' });
      assembler.push({ type: 'text-delta', index: 1, text: ' is 42.' });
      assembler.push({ type: 'block-end', index: 1, block: { type: 'text', text: 'Answer is 42.' } });

      assembler.push({ type: 'usage', usage: { inputTokens: 50, outputTokens: 20 } });
      assembler.push({ type: 'finish', reason: { kind: 'stop' }, model: 'deepseek-r1' });

      assert.equal(assembler.reasoning(), 'Thinking step 1.');
      assert.equal(assembler.text(), 'Answer is 42.');
      assert.equal(assembler.usage?.inputTokens, 50);
      assert.equal(assembler.usage?.outputTokens, 20);
      assert.equal(assembler.finish.kind, 'stop');
      assert.equal(assembler.model, 'deepseek-r1');
    });
  });

  describe('LiveLLMClient streaming integration', () => {
    let server: http.Server;
    let port: number;
    let nextResponseHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

    test.before(async () => {
      await new Promise<void>((resolve) => {
        server = http.createServer((req, res) => {
          if (nextResponseHandler) {
            nextResponseHandler(req, res);
          } else {
            res.writeHead(404).end();
          }
        });
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as { port: number };
          port = addr.port;
          resolve();
        });
      });
    });

    test.after(async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });

    it('streams completion text and matches expected assembled content', async () => {
      nextResponseHandler = (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write('data: {"choices":[{"delta":{"role":"assistant","content":"Hello"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":" streaming"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      };

      const client = new LiveLLMClient({
        endpoints: { openrouter: `http://127.0.0.1:${port}` },
      });

      const chunks: StreamChunk[] = [];
      const response = await client.generateCode({
        modelId: 'openai/gpt-4o',
        systemPrompt: 'You are an assistant',
        userPrompt: 'Hi',
        onStream: (chunk) => chunks.push(chunk),
      });

      assert.equal(response.content, 'Hello streaming world');
      assert.equal(response.inputTokens, 12);
      assert.equal(response.outputTokens, 3);
      assert.equal(response.finishReason, 'stop');
      assert.ok(chunks.length >= 3);
    });

    it('throws OUTPUT_LIMIT when finishReason is length or max_tokens', async () => {
      nextResponseHandler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"Truncated text"},"finish_reason":"length"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      };

      const client = new LiveLLMClient({
        endpoints: { openrouter: `http://127.0.0.1:${port}` },
      });

      await assert.rejects(
        async () => {
          await client.generateCode({
            modelId: 'openai/gpt-4o',
            systemPrompt: 'Sys',
            userPrompt: 'User',
            onStream: () => {},
          });
        },
        (err: any) => {
          assert.ok(err instanceof ProviderCallError);
          assert.equal(err.code, 'OUTPUT_LIMIT');
          return true;
        }
      );
    });

    it('throws EMPTY_RESPONSE when model streams reasoning but empty content', async () => {
      nextResponseHandler = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"reasoning_content":"Thinking about answer..."}}]}\n\n');
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      };

      const client = new LiveLLMClient({
        endpoints: { openrouter: `http://127.0.0.1:${port}` },
      });

      await assert.rejects(
        async () => {
          await client.generateCode({
            modelId: 'openai/gpt-4o',
            systemPrompt: 'Sys',
            userPrompt: 'User',
            onStream: () => {},
          });
        },
        (err: any) => {
          assert.ok(err instanceof ProviderCallError);
          assert.equal(err.code, 'EMPTY_RESPONSE');
          return true;
        }
      );
    });

    it('throws IDENTITY_UNVERIFIED and abandons when pinned gateway serves mismatched model', async () => {
      nextResponseHandler = (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'X-Routed-Via': 'deepseek/deepseek-chat',
        });
        res.write('data: {"model":"deepseek/deepseek-chat","choices":[{"delta":{"content":"Hi"}}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      };

      const mockResolver: ConnectionResolver = {
        async resolveForRequest(id: string) {
          return {
            id,
            baseUrl: `http://127.0.0.1:${port}`,
            apiKey: 'gw-key',
            label: 'TestGateway',
          };
        },
      };

      const client = new LiveLLMClient({
        connections: mockResolver,
      });

      await assert.rejects(
        async () => {
          await client.generateCode({
            modelId: 'openai/gpt-4o',
            systemPrompt: 'Sys',
            userPrompt: 'User',
            connection: { id: 'conn-1', routingMode: 'pinned' },
            onStream: () => {},
          });
        },
        (err: any) => {
          assert.ok(err instanceof ProviderCallError);
          assert.equal(err.code, 'IDENTITY_UNVERIFIED');
          return true;
        }
      );
    });

    it('keeps streaming when usage is unreported without replaying generation', async () => {
      let callCount = 0;
      let lastBody: any = null;

      nextResponseHandler = (req, res) => {
        callCount++;
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          lastBody = JSON.parse(raw);
          if (lastBody.stream) {
            // First call: stream with NO usage
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: {"choices":[{"delta":{"content":"Streamed answer"},"finish_reason":"stop"}]}\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            // Second call: non-streaming
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                choices: [{ message: { content: 'Non-streamed answer' } }],
                usage: { prompt_tokens: 8, completion_tokens: 4 },
              })
            );
          }
        });
      };

      const mockResolver: ConnectionResolver = {
        async resolveForRequest(id: string) {
          return {
            id,
            baseUrl: `http://127.0.0.1:${port}`,
            apiKey: 'gw-key',
            label: 'TestGateway',
          };
        },
      };

      const client = new LiveLLMClient({
        connections: mockResolver,
      });

      // Call 1: streamed, but usage is unreported
      const res1 = await client.generateCode({
        modelId: 'openai/gpt-4o',
        systemPrompt: 'Sys',
        userPrompt: 'User',
        connection: { id: 'conn-usage', routingMode: 'auto' },
        onStream: () => {},
      });
      assert.equal(res1.content, 'Streamed answer');
      assert.equal(res1.usageKnown, false);

      // Call 2: retain progress visibility even when accounting is unavailable.
      const res2 = await client.generateCode({
        modelId: 'openai/gpt-4o',
        systemPrompt: 'Sys',
        userPrompt: 'User',
        connection: { id: 'conn-usage', routingMode: 'auto' },
        onStream: () => {},
      });
      assert.equal(res2.content, 'Streamed answer');
      assert.equal(res2.usageKnown, false);
      assert.equal(lastBody.stream, true);
      assert.equal(callCount, 2, 'Exactly one dispatch per request');
    });
  });

  describe('LiveChannel attempt tracking', () => {
    it('manages attempt lifecycle and updates snapshot in memory', () => {
      const frames: RunLiveFrame[] = [];
      const live = new LiveChannel((runId, frame) => {
        frames.push(frame);
      });

      live.startAttempt('run-stream', 'attempt-1', 1);
      assert.equal(frames.length, 1);
      assert.equal(frames[0].kind, 'attempt');
      assert.equal((frames[0] as any).phase, 'start');

      live.chunk('run-stream', 'attempt-1', 1, 0, { type: 'reasoning-delta', text: 'Thinking...' });
      live.chunk('run-stream', 'attempt-1', 1, 1, { type: 'text-delta', text: 'Hello' });
      live.chunk('run-stream', 'attempt-1', 1, 2, { type: 'text-delta', text: ' world' });

      const snap = live.getSnapshot('run-stream');
      assert.equal(snap.attempts.length, 1);
      assert.equal(snap.attempts[0].attemptId, 'attempt-1');
      assert.equal(snap.attempts[0].reasoning, 'Thinking...');
      assert.equal(snap.attempts[0].text, 'Hello world');

      live.endAttempt('run-stream', 'attempt-1', 1, 'committed');
      const snapAfter = live.getSnapshot('run-stream');
      assert.equal(snapAfter.attempts.length, 0);

      const endFrame = frames[frames.length - 1];
      assert.equal(endFrame.kind, 'attempt');
      assert.equal((endFrame as any).phase, 'end');
      assert.equal((endFrame as any).outcome, 'committed');

      live.closeRun('run-stream');
    });
  });
});
