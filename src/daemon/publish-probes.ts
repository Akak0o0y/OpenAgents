import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

/**
 * Site knowledge for the one irreversible request the routines make: a post on x.com.
 *
 * Inferred, not verified: X's CreateTweet request and response shapes and the not-created
 * error codes are general knowledge of X's web client. Neither the database nor a fixture has
 * observed them. Classification therefore never relies on one fixed path, and every verdict
 * carries the response's key names (never its values), so the owner's normal runs reveal the
 * real shape. This module is pure: no store, no Playwright.
 */

export interface ProbedRequest { probe: string; op: 'post' | 'reply' | 'unknown'; text?: string; inReplyTo?: string }
export type ProbeVerdict =
  | { outcome: 'confirmed'; postId: string; shape: string[] }
  | { outcome: 'rejected'; reason: string; errorCodes: number[]; shape: string[] }
  | { outcome: 'unobserved'; reason: string; errorCodes: number[]; shape: string[] };
export interface PublishProbe {
  id: string;                                   // 'x.com/create-tweet'
  origins: readonly string[];                   // ['https://x.com']; fixtures pass their own
  match(req: { method: string; url: URL; postData: string | null }): ProbedRequest | null;
  classify(res: { status: number; body: Buffer | null }): ProbeVerdict;
  notCreatedCodes: ReadonlySet<number>;         // 88, 186, 187, 226, 344, 385, 433 (inferred)
  account: { role: 'link'; name: string };      // X: link 'Profile' whose href is /<handle>
  postPath(account: string, postId: string): string;
  profilePaths(account: string, op: ProbedRequest['op']): string[];
  /** Where an unrecognised write that repeats the typed text can still be a post (a renamed publish request).
   *  Absent: every path on the probe's origins. */
  echoPaths?: RegExp;
}

// 88 rate limit, 186 too long, 187 duplicate, 226 looks automated, 344 daily limit,
// 385 reply target unavailable, 433 replies restricted. Inferred, not observed.
const X_NOT_CREATED_CODES: readonly number[] = [88, 186, 187, 226, 344, 385, 433];
const CREATE_KEYS: ReadonlySet<string> = new Set(['create_tweet', 'notetweet_create']);
const CREATE_SEARCH_DEPTH = 8;
const MAX_SHAPE_PATHS = 40;
const MAX_SHAPE_DEPTH = 6;
const MAX_SHAPE_ARRAY_ITEMS = 50;
const SHAPE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
const DIGIT_RUN = /\d{5,}/;
const ALL_DIGITS = /^\d+$/;
const MIN_ECHO_CHARS = 8;
const MATCH_PREFIX_CHARS = 40;
const URL_WEIGHT = 23;
const SNOWFLAKE_EPOCH = 1288834974657n;
const FULL_URL = /\bhttps?:\/\/\S+/giu;
// X's display form of a link: the scheme is dropped and a long path ends in '…' (example.com/pa…).
const DISPLAY_URL = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?/giu;
const TRAILING_SHOW_MORE = /\s*Show more\s*$/iu;
const TRAILING_ELLIPSIS = /\s*…\s*$/u;
// Emoji (pictographs, skin-tone modifiers, flag letters, variation selectors, keycap and tag
// characters) and zero-width characters. X renders emoji as images, so the article text drops them.
const EMOJI_AND_ZERO_WIDTH = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u{FE0E}\u{FE0F}\u{20E3}\u{E0020}-\u{E007F}\u{200B}-\u{200D}\u{2060}\u{FEFF}]/gu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; }
}

/** The GraphQL `variables` object of a request body, accepting an object or a JSON string. */
function requestVariables(postData: string | null): Record<string, unknown> | null {
  if (!postData) return null;
  const body = parseJson(postData);
  if (!body.ok || !isRecord(body.value)) return null;
  let variables = body.value.variables;
  if (typeof variables === 'string') {
    const inner = parseJson(variables);
    variables = inner.ok ? inner.value : undefined;
  }
  return isRecord(variables) ? variables : null;
}

/** Objects held under a create_tweet or notetweet_create key, breadth first, at most maxDepth levels below root. */
function createObjects(root: unknown, maxDepth: number): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  let level: unknown[] = [root];
  for (let depth = 0; depth < maxDepth && level.length > 0; depth++) {
    const next: unknown[] = [];
    for (const node of level) {
      if (Array.isArray(node)) { for (const item of node) if (typeof item === 'object' && item !== null) next.push(item); continue; }
      if (!isRecord(node)) continue;
      for (const [key, value] of Object.entries(node)) {
        if (CREATE_KEYS.has(key) && isRecord(value)) found.push(value);
        if (typeof value === 'object' && value !== null) next.push(value);
      }
    }
    level = next;
  }
  return found;
}

/** The shallowest all-digit rest_id inside a create object: the post's own id, not its author's. */
function restIdIn(root: Record<string, unknown>): string | undefined {
  let level: unknown[] = [root];
  for (let depth = 0; depth < CREATE_SEARCH_DEPTH && level.length > 0; depth++) {
    const next: unknown[] = [];
    for (const node of level) {
      if (Array.isArray(node)) { for (const item of node) if (typeof item === 'object' && item !== null) next.push(item); continue; }
      if (!isRecord(node)) continue;
      const id = node.rest_id;
      if (typeof id === 'string' && ALL_DIGITS.test(id)) return id;
      for (const value of Object.values(node)) if (typeof value === 'object' && value !== null) next.push(value);
    }
    level = next;
  }
  return undefined;
}

/** Numeric codes of the top-level errors[] entries (code or extensions.code), deduplicated, in order. */
function errorCodesOf(json: unknown): number[] {
  if (!isRecord(json) || !Array.isArray(json.errors)) return [];
  const codes: number[] = [];
  for (const entry of json.errors.slice(0, 20)) {
    if (!isRecord(entry)) continue;
    const nested = isRecord(entry.extensions) ? entry.extensions.code : undefined;
    for (const code of [entry.code, nested]) if (typeof code === 'number' && Number.isInteger(code) && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

function classifyCreateTweet(res: { status: number; body: Buffer | null }, notCreated: ReadonlySet<number>): ProbeVerdict {
  const status = res.status;
  if (!res.body || res.body.length === 0) return { outcome: 'unobserved', reason: 'empty-body', errorCodes: [], shape: [] };
  const parsed = parseJson(res.body.toString('utf8'));
  if (!parsed.ok) return { outcome: 'unobserved', reason: 'unparseable-body', errorCodes: [], shape: [] };
  const json = parsed.value;
  const shape = responseShape(json);
  const errorCodes = errorCodesOf(json);
  if (status >= 500) return { outcome: 'unobserved', reason: `http ${status}`, errorCodes, shape };
  const success = status >= 200 && status < 300;
  if (success && isRecord(json)) {
    for (const created of createObjects(json.data, CREATE_SEARCH_DEPTH)) {
      const postId = restIdIn(created);
      if (postId) return { outcome: 'confirmed', postId, shape };
    }
  }
  const anyCreate = createObjects(json, CREATE_SEARCH_DEPTH + 1).length > 0;
  if (!anyCreate && (status === 200 || (status >= 400 && status < 500))) {
    const code = errorCodes.find(candidate => notCreated.has(candidate));
    if (code !== undefined) return { outcome: 'rejected', reason: `code ${code}`, errorCodes, shape };
  }
  const reason = anyCreate ? 'create-without-id' : errorCodes.length > 0 ? 'unlisted-code' : success ? 'no-create-object' : `http ${status}`;
  return { outcome: 'unobserved', reason, errorCodes, shape };
}

/** The X web client's post request. `origins` defaults to x.com; fixtures pass their own origin. */
export function xCreateTweet(origins: string[] = ['https://x.com']): PublishProbe {
  const id = 'x.com/create-tweet';
  const allowed: readonly string[] = [...origins];
  const notCreatedCodes: ReadonlySet<number> = new Set(X_NOT_CREATED_CODES);
  return {
    id,
    origins: allowed,
    notCreatedCodes,
    account: { role: 'link', name: 'Profile' },
    match(req) {
      if (req.method.toUpperCase() !== 'POST' || !allowed.includes(req.url.origin)) return null;
      const path = req.url.pathname;
      const last = path.slice(path.lastIndexOf('/') + 1);
      if (last !== 'CreateTweet' && last !== 'CreateNoteTweet') return null;
      const variables = requestVariables(req.postData);
      if (!variables) return { probe: id, op: 'unknown' };
      const text = typeof variables.tweet_text === 'string' ? variables.tweet_text : undefined;
      const reply = variables.reply;
      const target = isRecord(reply) && typeof reply.in_reply_to_tweet_id === 'string' && reply.in_reply_to_tweet_id !== '' ? reply.in_reply_to_tweet_id : undefined;
      const probed: ProbedRequest = { probe: id, op: target ? 'reply' : 'post' };
      if (text !== undefined) probed.text = text;
      if (target) probed.inReplyTo = target;
      return probed;
    },
    classify: res => classifyCreateTweet(res, notCreatedCodes),
    postPath: (account, postId) => `/${account}/status/${postId}`,
    profilePaths: (account, op) => op === 'reply' ? [`/${account}/with_replies`] : [`/${account}`],
    // X posts through its GraphQL API. REST writes such as analytics (jot/client_event) and
    // draft saves can repeat typed search or draft text, and are never posts.
    echoPaths: /^\/i\/api\/graphql\//,
  };
}

/**
 * Key paths of a parsed response, values never kept: at most 40 paths, at most 6 levels (object
 * keys and array levels both count), an array-valued key written as `name[]`. A key that is not a
 * plain identifier, or that holds a run of 5 or more digits, is written as `*`.
 */
export function responseShape(json: unknown): string[] {
  const out = new Set<string>();
  const walk = (value: unknown, prefix: string, depth: number): void => {
    if (out.size >= MAX_SHAPE_PATHS || depth >= MAX_SHAPE_DEPTH) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, MAX_SHAPE_ARRAY_ITEMS)) walk(item, prefix, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    for (const key of Object.keys(value)) {
      if (out.size >= MAX_SHAPE_PATHS) return;
      const child = value[key];
      const name = (SHAPE_KEY.test(key) && !DIGIT_RUN.test(key) ? key : '*') + (Array.isArray(child) ? '[]' : '');
      const path = prefix ? `${prefix}.${name}` : name;
      out.add(path);
      walk(child, path, depth + 1);
    }
  };
  walk(json, '', 0);
  return [...out];
}

/** NFC, every whitespace run collapsed to one space, trimmed. The form hashed by textSha256. */
export function normalizeEcho(s: string): string {
  return s.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** NFKC, emoji and zero-width characters stripped, casefolded, whitespace runs collapsed to one space, trimmed. */
export function normalizeMatch(s: string): string {
  return s.normalize('NFKC').replace(EMOJI_AND_ZERO_WIDTH, '').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/** True when the body carries the text raw, JSON-escaped or URL-encoded, and the normalized text has at least 8 characters. */
export function echoes(body: string, text: string): boolean {
  const normalized = normalizeEcho(text);
  if ([...normalized].length < MIN_ECHO_CHARS) return false;
  for (const candidate of new Set([text, normalized])) {
    if (!candidate) continue;
    const encoded = encodeURIComponent(candidate);
    const forms = [candidate, JSON.stringify(candidate).slice(1, -1), encoded, encoded.replace(/%20/g, '+')];
    if (forms.some(form => body.includes(form))) return true;
  }
  return false;
}

/** X's weighted length: code points above U+10FF count 2, and each http(s) URL counts 23. */
export function weightedLength(s: string): number {
  let urls = 0;
  const rest = s.replace(FULL_URL, () => { urls += 1; return ''; });
  let length = urls * URL_WEIGHT;
  for (const ch of rest) length += (ch.codePointAt(0) ?? 0) > 0x10ff ? 2 : 1;
  return length;
}

/** Creation time in ms encoded in an X post id (a snowflake); null when the id is not all digits. */
export function snowflakeMs(id: string): number | null {
  if (!ALL_DIGITS.test(id)) return null;
  return Number((BigInt(id) >> 22n) + SNOWFLAKE_EPOCH);
}

/** The digits of a trailing /status/<id>, otherwise null. */
export function statusIdOf(path: string): string | null {
  const found = /\/status\/(\d+)$/u.exec(path);
  return found ? found[1] : null;
}

/** Lowercase hex sha256 of normalizeEcho(text): the one hash used for textSha256, recent.textHashes and Stage 2. */
export function textSha256(text: string): string {
  return createHash('sha256').update(normalizeEcho(text), 'utf8').digest('hex');
}

function withoutDisplayNoise(s: string): string {
  return s.replace(FULL_URL, ' ').replace(DISPLAY_URL, ' ').replace(TRAILING_SHOW_MORE, '').replace(TRAILING_ELLIPSIS, '');
}

/**
 * The page check's text rule. `typed` is the text the bot filled; `shown` is the text an article
 * renders (read with innerText, which keeps <br> line breaks as whitespace). URLs are removed from
 * both (full URLs and X's display form such as 'example.com/pa…'), a trailing '…' and 'Show more'
 * are stripped, both sides go through normalizeMatch, and the shown text must contain the first
 * 40 characters of the typed text, or all of it when it is shorter.
 */
export function matchesPostText(typed: string, shown: string): boolean {
  const want = normalizeMatch(withoutDisplayNoise(typed));
  if (!want) return false;
  const have = normalizeMatch(withoutDisplayNoise(shown));
  return have.includes([...want].slice(0, MATCH_PREFIX_CHARS).join(''));
}
