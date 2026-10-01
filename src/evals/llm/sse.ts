/**
 * Zero-dependency Server-Sent Events (SSE) reader.
 *
 * Decodes SSE data payloads from a readable byte stream.
 * - Handles \r\n, \n, \r line endings
 * - Skips SSE comments (lines starting with ':')
 * - Accumulates multiple 'data:' lines per event separated by \n
 * - Enforces a 2 MiB stream size cap
 * - Cancels and releases the stream reader on abort or termination
 */

import { ProviderCallError } from '../llm-client.js';

export const DONE = '[DONE]';
const MAX_STREAM_BYTES = 2 * 1024 * 1024; // 2 MiB

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let bytesRead = 0;
  let currentEventData: string[] = [];

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel();
        throw new ProviderCallError('CANCELLED', 'Stream request aborted by caller.');
      }

      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      bytesRead += value.byteLength;
      if (bytesRead > MAX_STREAM_BYTES) {
        await reader.cancel();
        throw new ProviderCallError('INVALID_RESPONSE', 'Provider response exceeded the 2 MiB limit.');
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line === '') {
          if (currentEventData.length > 0) {
            const dataPayload = currentEventData.join('\n');
            currentEventData = [];
            yield dataPayload;
            if (dataPayload === DONE) {
              return;
            }
          }
        } else if (line.startsWith(':')) {
          // Comment line, ignore
          continue;
        } else if (line.startsWith('data:')) {
          const content = line.slice(5).replace(/^\s/, '');
          currentEventData.push(content);
        }
      }
    }

    // Flush any remaining buffer at EOF
    buffer += decoder.decode();
    if (buffer.length > 0) {
      const remainingLines = buffer.split(/\r\n|\r|\n/);
      for (const line of remainingLines) {
        if (line === '') {
          if (currentEventData.length > 0) {
            const dataPayload = currentEventData.join('\n');
            currentEventData = [];
            yield dataPayload;
            if (dataPayload === DONE) return;
          }
        } else if (!line.startsWith(':') && line.startsWith('data:')) {
          currentEventData.push(line.slice(5).replace(/^\s/, ''));
        }
      }
    }

    if (currentEventData.length > 0) {
      const dataPayload = currentEventData.join('\n');
      yield dataPayload;
    }
  } finally {
    reader.releaseLock();
  }
}
