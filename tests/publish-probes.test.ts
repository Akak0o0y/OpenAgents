import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  echoes,
  matchesPostText,
  normalizeEcho,
  normalizeMatch,
  responseShape,
  snowflakeMs,
  statusIdOf,
  textSha256,
  weightedLength,
  xCreateTweet,
} from '../src/daemon/publish-probes.js';

/**
 * The X CreateTweet probe and the pure text and id helpers (spec section 6.1).
 * The request and response shapes and the not-created codes are inferred, never observed:
 * every test whose pass depends on them says "(assumed X response shape)" in its title.
 */

const probe = xCreateTweet();
const request = (method: string, url: string, postData: string | null = null) => ({ method, url: new URL(url), postData });
const body = (json: unknown) => Buffer.from(JSON.stringify(json));
const postBody = (variables: unknown) => JSON.stringify({ variables, features: { longform_notetweets_consumption_enabled: true }, queryId: 'AbC123' });

test('the X probe carries its fixed site knowledge (assumed X response shape)', () => {
  assert.equal(probe.id, 'x.com/create-tweet');
  assert.deepEqual([...probe.origins], ['https://x.com']);
  assert.deepEqual([...probe.notCreatedCodes].sort((a, b) => a - b), [88, 186, 187, 226, 344, 385, 433]);
  assert.deepEqual(probe.account, { role: 'link', name: 'Profile' });
  assert.equal(probe.postPath('fixture_bot', '2101869834065576282'), '/fixture_bot/status/2101869834065576282');
  assert.deepEqual(probe.profilePaths('fixture_bot', 'reply'), ['/fixture_bot/with_replies']);
  assert.deepEqual(probe.profilePaths('fixture_bot', 'post'), ['/fixture_bot']);
  assert.deepEqual(probe.profilePaths('fixture_bot', 'unknown'), ['/fixture_bot']);
  assert.deepEqual([...xCreateTweet(['http://127.0.0.1:5173']).origins], ['http://127.0.0.1:5173']);
});

test('match takes the last path segment and ignores the queryId and query string (assumed X response shape)', () => {
  const text = postBody({ tweet_text: 'A post from the fixture bot' });
  assert.equal(probe.match(request('POST', 'https://x.com/i/api/graphql/AbC123/CreateTweet?features=1', text))?.probe, 'x.com/create-tweet');
  assert.equal(probe.match(request('POST', 'https://x.com/i/api/graphql/Zz9/CreateNoteTweet', text))?.probe, 'x.com/create-tweet');
  assert.equal(probe.match(request('GET', 'https://x.com/i/api/graphql/AbC123/CreateTweet', null)), null);
  assert.equal(probe.match(request('POST', 'https://twitter.com/i/api/graphql/AbC123/CreateTweet', text)), null);
  assert.equal(probe.match(request('POST', 'https://x.com/i/api/graphql/AbC123/CreateTweetDraft', text)), null);
  assert.equal(probe.match(request('POST', 'https://x.com/i/api/1.1/drafts/autosave.json', text)), null);
  const local = xCreateTweet(['http://127.0.0.1:5173']);
  assert.equal(local.match(request('POST', 'http://127.0.0.1:5173/i/api/graphql/q1/CreateTweet', text))?.op, 'post');
  assert.equal(local.match(request('POST', 'https://x.com/i/api/graphql/q1/CreateTweet', text)), null);
});

test('match parses the text and the reply target best-effort (assumed X response shape)', () => {
  const url = 'https://x.com/i/api/graphql/AbC123/CreateTweet';
  assert.deepEqual(probe.match(request('POST', url, postBody({ tweet_text: 'Nice point, well made', reply: { in_reply_to_tweet_id: '2101869834065576282', exclude_reply_user_ids: [] } }))),
    { probe: 'x.com/create-tweet', op: 'reply', text: 'Nice point, well made', inReplyTo: '2101869834065576282' });
  assert.deepEqual(probe.match(request('POST', url, postBody({ tweet_text: 'A post of its own' }))),
    { probe: 'x.com/create-tweet', op: 'post', text: 'A post of its own' });
  // variables may arrive as a JSON string
  assert.deepEqual(probe.match(request('POST', url, JSON.stringify({ variables: JSON.stringify({ tweet_text: 'Encoded variables' }) }))),
    { probe: 'x.com/create-tweet', op: 'post', text: 'Encoded variables' });
  assert.deepEqual(probe.match(request('POST', url, 'not json at all')), { probe: 'x.com/create-tweet', op: 'unknown' });
  assert.deepEqual(probe.match(request('POST', url, null)), { probe: 'x.com/create-tweet', op: 'unknown' });
  assert.deepEqual(probe.match(request('POST', url, JSON.stringify({ queryId: 'AbC123' }))), { probe: 'x.com/create-tweet', op: 'unknown' });
});

test('classify: confirmed for 200 with rest_id at the usual path (assumed X response shape)', () => {
  const verdict = probe.classify({ status: 200, body: body({ data: { create_tweet: { tweet_results: { result: {
    rest_id: '2101869834065576282',
    core: { user_results: { result: { rest_id: '1799999999999999999', legacy: { screen_name: 'fixture_bot' } } } },
    legacy: { full_text: 'BODY_MARKER_TEXT' },
  } } } } }) });
  assert.equal(verdict.outcome, 'confirmed');
  assert.equal(verdict.outcome === 'confirmed' && verdict.postId, '2101869834065576282');
  assert.ok(verdict.shape.includes('data.create_tweet.tweet_results.result.rest_id'));
  const shapeText = JSON.stringify(verdict.shape);
  for (const value of ['BODY_MARKER_TEXT', 'fixture_bot', '2101869834065576282', '1799999999999999999']) assert.ok(!shapeText.includes(value), value);
});

test('classify: confirmed for 200 with the id in a visibility wrapper plus a warning in errors[] (assumed X response shape)', () => {
  const verdict = probe.classify({ status: 200, body: body({
    data: { create_tweet: { tweet_results: { result: { __typename: 'TweetWithVisibilityResults',
      tweet: { rest_id: '1234567890123456789', core: { user_results: { result: { rest_id: '1799999999999999999' } } } },
      limitedActionResults: { limited_actions: [{ action: 'Reply' }] } } } } },
    errors: [{ message: 'Partial result', code: 37, kind: 'Permissions' }],
  }) });
  assert.equal(verdict.outcome, 'confirmed');
  assert.equal(verdict.outcome === 'confirmed' && verdict.postId, '1234567890123456789');
  const note = probe.classify({ status: 200, body: body({ data: { notetweet_create: { tweet_results: { result: { rest_id: '2101869834065576282' } } } } }) });
  assert.equal(note.outcome, 'confirmed');
});

test('classify: rejected for code 187 at 200, 226 at 403 and 88 at 429, with no create object (assumed X response shape)', () => {
  for (const [status, code] of [[200, 187], [403, 226], [429, 88]] as const) {
    const verdict = probe.classify({ status, body: body({ errors: [{ message: 'X said no', code }], data: {} }) });
    assert.equal(verdict.outcome, 'rejected', `${status}/${code}`);
    assert.equal(verdict.outcome === 'rejected' && verdict.reason, `code ${code}`);
    assert.deepEqual(verdict.outcome === 'rejected' && verdict.errorCodes, [code]);
  }
  const nested = probe.classify({ status: 200, body: body({ errors: [{ message: 'Duplicate', extensions: { code: 187 } }] }) });
  assert.equal(nested.outcome, 'rejected');
});

test('classify: unobserved for unlisted codes, a create object without rest_id, 4xx, 5xx and unreadable bodies (assumed X response shape)', () => {
  const cases: Array<[string, { status: number; body: Buffer | null }, string, number[]]> = [
    ['200 with code 999', { status: 200, body: body({ errors: [{ code: 999 }] }) }, 'unlisted-code', [999]],
    ['create object without rest_id', { status: 200, body: body({ data: { create_tweet: { tweet_results: {} } }, errors: [{ code: 187 }] }) }, 'create-without-id', [187]],
    ['non-digit rest_id', { status: 200, body: body({ data: { create_tweet: { tweet_results: { result: { rest_id: 'abc' } } } } }) }, 'create-without-id', []],
    ['4xx with an unlisted code', { status: 400, body: body({ errors: [{ code: 999 }] }) }, 'unlisted-code', [999]],
    ['4xx without codes', { status: 404, body: body({}) }, 'http 404', []],
    ['5xx', { status: 503, body: body({ errors: [{ code: 187 }] }) }, 'http 503', [187]],
    ['200 without a create object', { status: 200, body: body({ data: {} }) }, 'no-create-object', []],
    ['empty body', { status: 200, body: Buffer.alloc(0) }, 'empty-body', []],
    ['no body', { status: 200, body: null }, 'empty-body', []],
    ['unparseable body', { status: 200, body: Buffer.from('<html>busy</html>') }, 'unparseable-body', []],
  ];
  for (const [name, res, reason, errorCodes] of cases) {
    const verdict = probe.classify(res);
    assert.equal(verdict.outcome, 'unobserved', name);
    assert.equal(verdict.outcome === 'unobserved' && verdict.reason, reason, name);
    assert.deepEqual(verdict.outcome === 'unobserved' && verdict.errorCodes, errorCodes, name);
  }
});

test('responseShape keeps key names only, masks odd and numeric keys, and is bounded', () => {
  const shape = responseShape({ errors: [{ code: 187, message: 'VALUE_MARKER' }], data: { '1234567': { ok: 1 }, 'user-name': 'x', id12345: 2, plain_key: [1, 2] } });
  assert.deepEqual(shape, ['errors[]', 'errors[].code', 'errors[].message', 'data', 'data.*', 'data.*.ok', 'data.plain_key[]']);
  assert.ok(!JSON.stringify(shape).includes('VALUE_MARKER'));
  const deep = responseShape({ a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } });
  assert.deepEqual(deep, ['a', 'a.b', 'a.b.c', 'a.b.c.d', 'a.b.c.d.e', 'a.b.c.d.e.f']);
  const wide = responseShape(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`key_${String.fromCharCode(97 + (i % 26))}${i}`, i])));
  assert.equal(wide.length, 40);
  assert.deepEqual(responseShape('just a string'), []);
  assert.deepEqual(responseShape(null), []);
});

test('snowflakeMs decodes X ids with BigInt and refuses anything that is not all digits', () => {
  assert.equal(snowflakeMs('2101869834065576282'), 1789959793951);
  assert.equal(snowflakeMs('1234567890123456789'), 1790065032289);
  assert.equal(snowflakeMs('abc'), null);
  assert.equal(snowflakeMs('12a'), null);
  assert.equal(snowflakeMs(''), null);
});

test('statusIdOf takes the digits of a trailing /status/<id> only', () => {
  assert.equal(statusIdOf('/h/status/123'), '123');
  assert.equal(statusIdOf('/fixture_bot/status/2101869834065576282'), '2101869834065576282');
  assert.equal(statusIdOf('/h/status/123/photo/1'), null);
  assert.equal(statusIdOf('/h/with_replies'), null);
  assert.equal(statusIdOf('/h/status/abc'), null);
});

test('normalizeEcho applies NFC and collapses whitespace', () => {
  assert.equal(normalizeEcho('  Café \n\t  time  '), 'Café time');
  assert.equal(normalizeEcho('one\n\ntwo'), 'one two');
});

test('normalizeMatch applies NFKC, strips emoji and zero-width characters, casefolds and collapses whitespace', () => {
  assert.equal(normalizeMatch('Ｇｒｅａｔ day'), 'great day');
  assert.equal(normalizeMatch('hel​lo wo⁠rld﻿'), 'hello world');
  assert.equal(normalizeMatch('Nice day \u{1F389}\u{1F44D}\u{1F3FD} ok ❤️'), 'nice day ok');
  assert.equal(normalizeMatch('Go \u{1F1F8}\u{1F1E6} team \u{1F468}‍\u{1F469}‍\u{1F467}!'), 'go team !');
  assert.equal(normalizeMatch('  Line one\n\nLine   two '), 'line one line two');
});

test('matchesPostText survives dropped emoji, line breaks, doubled spaces, shortened URLs and Show more', () => {
  // X shows emoji as images, so the article text drops them
  assert.ok(matchesPostText('Sunny morning \u{1F31E} walking the dog before work', 'Sunny morning  walking the dog before work'));
  // paragraphs: innerText keeps <br> as line breaks
  assert.ok(matchesPostText('First paragraph here.\n\nSecond paragraph of the post', 'First paragraph here.\nSecond paragraph of the post'));
  // HTML collapses a doubled space
  assert.ok(matchesPostText('Two  spaces between words in this post', 'Two spaces between words in this post'));
  // a link is shown in its display form
  assert.ok(matchesPostText('Great read today, worth every minute of it https://example.com/very/long/path', 'Great read today, worth every minute of it example.com/very/lo…'));
  assert.ok(matchesPostText('Read https://example.com/very/long/path before the meeting starts today', 'Read example.com/very/lo… before the meeting starts today'));
  // a long post is truncated behind Show more
  const long = 'This is a long post that goes on and on about the weather, the dog, the coffee and the morning walk. '.repeat(3).trim();
  assert.ok(matchesPostText(long, long.slice(0, 200) + '… Show more'));
  // inside the whole article text, with author, handle and counts around it
  assert.ok(matchesPostText('Short and sweet', 'Fixture Bot @fixture_bot · 1m Short and sweet 3 12'));
  assert.ok(!matchesPostText('hello world, this is a test post', 'a completely different post about cats'));
  assert.ok(!matchesPostText('https://example.com/only-a-link', 'example.com/only-a-link'));
  assert.ok(!matchesPostText('', 'anything'));
});

test('echoes matches raw, JSON-escaped and URL-encoded bodies of text of 8 characters or more', () => {
  assert.ok(echoes('{"variables":{"tweet_text":"Hello there, world"}}', 'Hello there, world'));
  const quoted = 'Line one\nLine "two"';
  assert.ok(echoes(JSON.stringify({ text: quoted }), quoted));
  assert.ok(echoes('text=' + encodeURIComponent('Hello there, world'), 'Hello there, world'));
  assert.ok(echoes('text=Hello+there%2C+world', 'Hello there, world'));
  assert.ok(echoes('abcdefgh', 'abcdefgh'));
  assert.ok(!echoes('{"text":"short"}', 'short'));
  assert.ok(!echoes('{"text":"ab cd"}', '  ab    cd  '));
  assert.ok(!echoes('{"text":"something else entirely"}', 'Hello there, world'));
});

test('weightedLength counts code points above U+10FF as 2 and each URL as 23', () => {
  assert.equal(weightedLength('hello'), 5);
  assert.equal(weightedLength('hi \u{1F389}'), 5);
  assert.equal(weightedLength('日本'), 4);
  assert.equal(weightedLength('café'), 4);
  assert.equal(weightedLength('see https://example.com/a/very/long/path now'), 31);
  assert.equal(weightedLength('https://a.example/x https://b.example/y'), 47);
});

test('textSha256 is the sha256 hex of normalizeEcho(text)', () => {
  const expected = createHash('sha256').update('Hello world', 'utf8').digest('hex');
  assert.equal(textSha256('Hello world'), expected);
  assert.equal(textSha256('  Hello \n  world '), expected);
  assert.match(textSha256('anything'), /^[0-9a-f]{64}$/);
  assert.notEqual(textSha256('Hello world'), textSha256('Hello world!'));
});
