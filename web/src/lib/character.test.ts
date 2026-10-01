import { afterEach, expect, it, vi } from 'vitest';
import { characterClient } from './character.js';

afterEach(() => vi.unstubAllGlobals());

it('preserves conflict status, current version and cancellation signal', async () => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ error: 'Changed in another window', code: 'CharacterConflict', currentVersion: 4 }), { status: 409 }));
  vi.stubGlobal('fetch', fetch);
  const signal = new AbortController().signal;
  await expect(characterClient.save('a', 3, {}, signal)).rejects.toMatchObject({ status: 409, code: 'CharacterConflict', currentVersion: 4 });
  expect(fetch.mock.calls[0][1]?.signal).toBe(signal);
});

it('GET has no paid side effect and preview is a separate abortable POST', async () => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 })); vi.stubGlobal('fetch', fetch);
  await characterClient.get('a b');
  expect(fetch.mock.calls[0][0]).toContain('agent=a%20b');
  const signal = new AbortController().signal;
  await characterClient.preview('a', {}, { type: 'chat', message: 'hello' }, signal);
  expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'POST', signal });
  expect(fetch.mock.calls[1][0]).toBe('/api/system/character-preview');
});
