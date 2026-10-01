import { randomUUID, createHash } from 'node:crypto';
import type { Buffer } from 'node:buffer';
import { echoes, textSha256, type ProbedRequest, type PublishProbe } from './publish-probes.js';
import type { CharacterPolicy, CharacterReservation } from './character-admission.js';

/**
 * The one place where "never post twice" and "proof of a post" are enforced for every model
 * session. One PublishWatch belongs to one run. It lives only in memory: noted fill texts,
 * the order of bot actions and operator input, the budget, dedupe and the tracked records.
 * Nothing it keeps or emits carries a body, cookie, query string or post text: only status,
 * op, origin, ids, error codes, key-name shape and sha256(normalizeEcho(text)).
 *
 * Structural request and response shapes only: this module never imports Playwright.
 */

export interface RunPolicy { publishLimit?: 1; recent?: { textHashes: ReadonlySet<string>; targets: ReadonlySet<string> }; character?: CharacterPolicy }
export interface PublishRecord { publishId: string; actionId?: string; by: 'model' | 'flow' | 'operator' | 'page'; probe: string; op: string; origin: string /* the request URL's origin */; unprobed?: boolean;
  state: 'pending' | 'confirmed' | 'rejected' | 'unobserved'; confirmedBy?: 'response' | 'page'; reason?: string; status?: number; errorCodes?: number[]; shape?: string[];
  postId?: string; postUrl?: string; inReplyTo?: string; textSha256?: string; exactDigest?:string; sentAt: number; settledAt?: number }
export type PublishAttempted = Pick<PublishRecord, 'publishId' | 'actionId' | 'by' | 'probe' | 'op' | 'origin' | 'unprobed' | 'inReplyTo' | 'textSha256' | 'exactDigest' | 'sentAt'> & { pathShape?: string };
export type PublishRefusalReason = 'budget' | 'duplicate-text' | 'duplicate-target' | 'expected-mismatch' | 'character-unadmitted' | 'character-unverifiable';
export interface PublishRequest { method: string; url: URL; postData: string | null }
export interface PublishResponse { status(): number; body(): Promise<Buffer> }
export type AdmitResult =
  | { kind: 'pass' }
  | { kind: 'refuse'; reason: PublishRefusalReason; by: PublishRecord['by']; actionId?: string; probe: string; op: string; character?: { utteranceId?: string; textSha256?: string } }
  | { kind: 'track'; record: PublishRecord; attempted: PublishAttempted; admission?: CharacterReservation };
export type PublishRouteDecision =
  | { kind: 'continue' }
  | { kind: 'abort'; refusal?: { reason: string; op: string; actionId?: string } }
  | { kind: 'track'; record: PublishRecord };

const SETTLE_CAP_MS = 20_000;          // track() settles every record by sentAt + 20 s
const ATTRIBUTION_WINDOW_MS = 20_000;  // a request up to 20 s after the latest bot STARTED is that action's
const POST_URL_WAIT_MS = 5_000;        // bound on resolvePostUrl before the confirmed PUBLISH_OBSERVED
const MAX_NOTED_FILLS = 100;
// Typing never submits (locator.fill), so an echo of a noted fill counts as an unprobed publish
// only when it comes from a submitting gesture, the operator or the page itself.
const SUBMIT_KINDS: ReadonlySet<string> = new Set(['click', 'double_click', 'press']);

interface BotAction { actionId: string; by: 'model' | 'flow'; kind: string; startedAt: number; seq: number }
interface Owner { by: PublishRecord['by']; actionId?: string; kind?: string }
type Observation = { outcome: 'confirmed' | 'rejected' | 'unobserved'; reason?: string; status?: number; errorCodes?: number[]; shape?: string[]; postId?: string };

/** A copy without undefined properties, so payloads and records carry only the fields that exist. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

function copy(record: PublishRecord): PublishRecord {
  return { ...record, ...(record.errorCodes ? { errorCodes: [...record.errorCodes] } : {}), ...(record.shape ? { shape: [...record.shape] } : {}) };
}

export class PublishWatch {
  private readonly probes: readonly PublishProbe[];
  private readonly policy: RunPolicy | undefined;
  private readonly emit: (type: string, payload: unknown) => void;
  private readonly now: () => number;
  private readonly resolvePostUrl: ((record: PublishRecord) => Promise<string | undefined>) | undefined;
  private readonly records: PublishRecord[] = [];
  private readonly tracking = new Map<string, Promise<PublishRecord>>();
  private readonly fills: Array<{ text: string; hash: string }> = [];
  private readonly open = new Map<string, BotAction>();
  private readonly refusals = new Map<string, { reason: PublishRefusalReason; op: ProbedRequest['op'] }>();
  private readonly listeners = new Set<() => void>();
  private latestStarted: BotAction | undefined;
  private operatorSeq = 0;
  private seq = 0;
  private expectations=new Map<string,{textSha256:string;inReplyTo?:string}>();
  expect(input:{actionId:string;text:string;inReplyTo?:string}):void {
    this.expectations.set(input.actionId,{textSha256:textSha256(input.text),inReplyTo:input.inReplyTo});
  }

  constructor(opts: { probes: PublishProbe[]; policy?: RunPolicy; emit: (type: string, payload: unknown) => void; now?: () => number;
    resolvePostUrl?: (record: PublishRecord) => Promise<string | undefined> }) {
    this.probes = [...opts.probes];
    this.policy = opts.policy;
    this.emit = opts.emit;
    this.now = opts.now ?? Date.now;
    this.resolvePostUrl = opts.resolvePostUrl;
  }

  /** A non-secret model or flow fill. Kept in memory only, never in a record or payload. */
  noteFill(text: string): void {
    if (!text) return;
    const known = this.fills.findIndex(fill => fill.text === text);
    if (known >= 0) this.fills.splice(known, 1);
    this.fills.push({ text, hash: textSha256(text) });
    if (this.fills.length > MAX_NOTED_FILLS) this.fills.shift();
  }

  /** At EXTERNAL_ACTION_STARTED. `kind` is the browser action (click, double_click, press, fill, ...). */
  beginAction(actionId: string, by: 'model' | 'flow', kind: string, at: number): void {
    const action: BotAction = { actionId, by, kind, startedAt: at, seq: ++this.seq };
    this.open.set(actionId, action);
    this.latestStarted = action;
  }

  /** At EXTERNAL_ACTION_FINISHED, or at the throw that leaves the action without one. */
  endAction(actionId: string, _at: number): void {
    this.open.delete(actionId);
  }

  /** Before an operator input is dispatched. The operator's text is never noted. */
  noteOperatorInput(_at: number): void {
    this.operatorSeq = ++this.seq;
  }

  /** Synchronous admission for a non-GET request on a probe origin. Never emits. */
  admit(req: PublishRequest): AdmitResult {
    if (req.method.toUpperCase() === 'GET') return { kind: 'pass' };
    const originProbe = this.probes.find(probe => probe.origins.includes(req.url.origin));
    if (!originProbe) return { kind: 'pass' };
    let probed: ProbedRequest | null = null;
    for (const probe of this.probes) { probed = probe.match(req); if (probed) break; }
    const echoPath = !originProbe.echoPaths || originProbe.echoPaths.test(req.url.pathname);
    const fill = probed || !echoPath ? undefined : this.echoedFill(req.postData);
    if (!probed && !fill) return { kind: 'pass' };
    const sentAt = this.now();
    const owner = this.attribute(sentAt);
    if (!probed && owner.kind !== undefined && !SUBMIT_KINDS.has(owner.kind)) return { kind: 'pass' };
    const probe = probed ? probed.probe : originProbe.id;
    const op: ProbedRequest['op'] = probed ? probed.op : 'unknown';
    const hash = probed ? (probed.text !== undefined && probed.text.trim() !== '' ? textSha256(probed.text) : undefined) : fill!.hash;
    const inReplyTo = probed?.inReplyTo;
    if (owner.by !== 'operator' && this.policy?.publishLimit === 1) {
      const reason = this.refusal(hash, inReplyTo);
      if (reason) {
        if (owner.actionId && !this.refusals.has(owner.actionId)) this.refusals.set(owner.actionId, { reason, op });
        return compact({ kind: 'refuse' as const, reason, by: owner.by, actionId: owner.actionId, probe, op });
      }
    }
    const expectation=owner.actionId?this.expectations.get(owner.actionId):undefined;
    if(owner.by==='flow'&&(!expectation||!probed||hash!==expectation.textSha256||inReplyTo!==expectation.inReplyTo)) {
      if(owner.actionId&&!this.refusals.has(owner.actionId))this.refusals.set(owner.actionId,{reason:'expected-mismatch',op});
      return compact({kind:'refuse' as const,reason:'expected-mismatch' as const,by:owner.by,actionId:owner.actionId,probe,op});
    }
    let admission: CharacterReservation | undefined;
    const character = this.policy?.character;
    if (character && owner.by !== 'operator') {
      const text = probed?.text !== undefined && probed.text.trim() !== '' ? probed.text : undefined;
      const found = text === undefined ? undefined : character.gate.reserve({ text, op, inReplyTo });
      if (found?.kind === 'reserved') admission = found.reservation;
      else if (character.requireAdmission) {
        const reason: PublishRefusalReason = text === undefined ? 'character-unverifiable' : 'character-unadmitted';
        if (owner.actionId && !this.refusals.has(owner.actionId)) this.refusals.set(owner.actionId, { reason, op });
        return compact({ kind: 'refuse' as const, reason, by: owner.by, actionId: owner.actionId, probe, op, character: compact({ utteranceId: found?.utteranceId, textSha256: hash }) });
      }
    }
    const record: PublishRecord = compact({ publishId: randomUUID(), actionId: owner.actionId, by: owner.by, probe, op, origin: req.url.origin,
      unprobed: probed ? undefined : true, state: 'pending' as const, inReplyTo, textSha256: hash, exactDigest:probed?.text===undefined?undefined:createHash('sha256').update(probed.text).digest('hex'), sentAt });
    this.records.push(record);
    this.changed();
    const attempted: PublishAttempted = compact({ publishId: record.publishId, actionId: record.actionId, by: record.by, probe, op, origin: record.origin,
      unprobed: record.unprobed, inReplyTo, textSha256: hash, exactDigest:record.exactDigest, sentAt, pathShape: probed ? undefined : req.url.pathname.replace(/\d{5,}/g, '*') });
    return { kind: 'track', record: copy(record), attempted, ...(admission ? { admission } : {}) };
  }

  /** Removes a record admit() created when its PUBLISH_ATTEMPTED insert then threw: that request is aborted and never left Chrome. */
  dropAdmitted(publishId: string): void {
    if (this.tracking.has(publishId)) return;
    const index = this.records.findIndex(record => record.publishId === publishId);
    if (index < 0 || this.records[index].state !== 'pending') return;
    this.records.splice(index, 1);
    this.changed();
  }

  /** Pure re-test after an admission failure: a probe match, or an echo of a noted fill, on a probe origin. May throw when a probe does. */
  recognizes(req: PublishRequest): boolean {
    if (req.method.toUpperCase() === 'GET') return false;
    if (!this.probes.some(probe => probe.origins.includes(req.url.origin))) return false;
    if (this.probes.some(probe => probe.match(req) !== null)) return true;
    return this.echoedFill(req.postData) !== undefined;
  }

  /**
   * Settles a record admitted by admit() at the first of: its response is classified; the request
   * fails (unobserved 'no-response'), or its body cannot be read (unobserved 'body-unreadable');
   * or sentAt + 20 s (unobserved 'timeout'). Unprobed records always settle unobserved 'unprobed'.
   * Emits PUBLISH_OBSERVED once per record and never rejects.
   */
  track(record: PublishRecord, response: Promise<PublishResponse | null>): Promise<PublishRecord> {
    const own = this.records.find(candidate => candidate.publishId === record.publishId);
    if (!own) { void Promise.resolve(response).catch(() => {}); return Promise.resolve(copy(record)); }
    const running = this.tracking.get(own.publishId);
    if (running) { void Promise.resolve(response).catch(() => {}); return running; }
    const done = this.settleRecord(own, response).catch(() => copy(own));
    this.tracking.set(own.publishId, done);
    return done;
  }

  /** The action's latest record once it is no longer pending, or whatever it is at deadlineMs (absolute) or when the signal fires. */
  async settle(actionId: string, deadlineMs: number, signal: AbortSignal): Promise<PublishRecord | undefined> {
    await this.waitUntil(() => { const latest = this.latestFor(actionId); return !!latest && latest.state !== 'pending'; }, deadlineMs, signal);
    const latest = this.latestFor(actionId);
    return latest ? copy(latest) : undefined;
  }

  /** Resolves when no record is pending, at untilMs (absolute), or when the signal fires, whichever is first. */
  allSettled(untilMs: number, signal: AbortSignal): Promise<void> {
    return this.waitUntil(() => !this.anyPending(), untilMs, signal);
  }

  /** The reason and op of the first route refusal of a request attributed to this action. */
  refusedFor(actionId: string): { reason: PublishRefusalReason; op: ProbedRequest['op'] } | undefined {
    const refusal = this.refusals.get(actionId);
    return refusal ? { ...refusal } : undefined;
  }

  anyPending(): boolean {
    return this.records.some(record => record.state === 'pending');
  }

  /** Records that are pending or unobserved. */
  unresolved(): readonly PublishRecord[] {
    return this.records.filter(record => record.state === 'pending' || record.state === 'unobserved').map(copy);
  }

  /** The noted fill whose sha256(normalizeEcho) equals record.textSha256; undefined for text the bot never filled. */
  textFor(record: PublishRecord): string | undefined {
    if (!record.textSha256) return undefined;
    for (let index = this.fills.length - 1; index >= 0; index--) if (this.fills[index].hash === record.textSha256) return this.fills[index].text;
    return undefined;
  }

  /** The page check found our own new post. Only a pending or unobserved record changes; it emits PUBLISH_RECONCILED {verdict:'present'}. */
  markConfirmedByPage(publishId: string, postUrl: string): void {
    const own = this.records.find(record => record.publishId === publishId);
    if (!own || (own.state !== 'pending' && own.state !== 'unobserved')) return;
    own.state = 'confirmed';
    own.confirmedBy = 'page';
    own.postUrl = postUrl;
    own.settledAt = this.now();
    try { this.emit('PUBLISH_RECONCILED', { publishId, verdict: 'present', postUrl, by: 'page-check' }); } catch { /* the store may be closed; the record keeps what the page showed */ }
    this.changed();
  }

  forAction(actionId: string): readonly PublishRecord[] {
    return this.records.filter(record => record.actionId === actionId).map(copy);
  }

  all(): readonly PublishRecord[] {
    return this.records.map(copy);
  }

  private echoedFill(postData: string | null): { text: string; hash: string } | undefined {
    if (!postData) return undefined;
    for (let index = this.fills.length - 1; index >= 0; index--) if (echoes(postData, this.fills[index].text)) return this.fills[index];
    return undefined;
  }

  /** Section 6.2 attribution, by the order of actions; it never reads a takeover flag. */
  private attribute(at: number): Owner {
    let open: BotAction | undefined;
    for (const action of this.open.values()) if (!open || action.seq > open.seq) open = action;
    if (open) return { by: open.by, actionId: open.actionId, kind: open.kind };
    const latest = this.latestStarted;
    if (this.operatorSeq > (latest?.seq ?? 0)) return { by: 'operator' };
    if (latest && at - latest.startedAt <= ATTRIBUTION_WINDOW_MS) return { by: latest.by, actionId: latest.actionId, kind: latest.kind };
    return { by: 'page' };
  }

  /** Routine-run checks, in order: budget, then duplicate-text, then duplicate-target. */
  private refusal(hash: string | undefined, inReplyTo: string | undefined): PublishRefusalReason | undefined {
    if (this.records.some(record => record.state !== 'rejected')) return 'budget';
    if (hash && (this.policy?.recent?.textHashes.has(hash) || this.records.some(record => record.textSha256 === hash))) return 'duplicate-text';
    if (inReplyTo && (this.policy?.recent?.targets.has(inReplyTo) || this.records.some(record => record.inReplyTo === inReplyTo))) return 'duplicate-target';
    return undefined;
  }

  private latestFor(actionId: string): PublishRecord | undefined {
    for (let index = this.records.length - 1; index >= 0; index--) if (this.records[index].actionId === actionId) return this.records[index];
    return undefined;
  }

  private async settleRecord(own: PublishRecord, response: Promise<PublishResponse | null>): Promise<PublishRecord> {
    const failed: Observation = { outcome: 'unobserved', reason: own.unprobed ? 'unprobed' : 'no-response' };
    const observed = await new Promise<Observation>(resolve => {
      const cap = setTimeout(() => resolve({ outcome: 'unobserved', reason: own.unprobed ? 'unprobed' : 'timeout' }), Math.max(0, own.sentAt + SETTLE_CAP_MS - this.now()));
      this.observe(own, response).then(
        observation => { clearTimeout(cap); resolve(observation); },
        () => { clearTimeout(cap); resolve(failed); });
    });
    const postUrl = observed.outcome === 'confirmed' ? await this.postUrlFor({ ...copy(own), postId: observed.postId }) : undefined;
    const settledAt = this.now();
    if (own.state === 'pending') {
      own.state = observed.outcome;
      if (observed.outcome === 'confirmed') own.confirmedBy = 'response';
      Object.assign(own, compact({ reason: observed.reason, status: observed.status, errorCodes: observed.errorCodes, shape: observed.shape, postId: observed.postId, postUrl, settledAt }));
    }
    const payload = compact({ publishId: own.publishId, outcome: observed.outcome, reason: observed.reason, status: observed.status, errorCodes: observed.errorCodes,
      shape: observed.shape, postId: observed.postId, postUrl, settledAt });
    try { this.emit('PUBLISH_OBSERVED', payload); } catch { /* the store may already be closed; the record keeps its verdict */ }
    this.changed();
    return copy(own);
  }

  private async observe(own: PublishRecord, response: Promise<PublishResponse | null>): Promise<Observation> {
    const res = await response;
    if (!res) return { outcome: 'unobserved', reason: own.unprobed ? 'unprobed' : 'no-response' };
    const status = res.status();
    const probe = this.probes.find(candidate => candidate.id === own.probe);
    if (own.unprobed || !probe) return { outcome: 'unobserved', reason: 'unprobed', status };
    let body: Buffer;
    try { body = await res.body(); } catch { return { outcome: 'unobserved', reason: 'body-unreadable', status }; }
    let verdict;
    try { verdict = probe.classify({ status, body }); } catch { return { outcome: 'unobserved', reason: 'classify-failed', status }; }
    if (verdict.outcome === 'confirmed') return { outcome: 'confirmed', status, shape: verdict.shape, postId: verdict.postId };
    return { outcome: verdict.outcome, reason: verdict.reason, status, errorCodes: verdict.errorCodes, shape: verdict.shape };
  }

  private async postUrlFor(record: PublishRecord): Promise<string | undefined> {
    if (!this.resolvePostUrl) return undefined;
    const resolve = this.resolvePostUrl;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => resolve(record)),
        new Promise<undefined>(done => { timer = setTimeout(() => done(undefined), POST_URL_WAIT_MS); }),
      ]);
    } catch { return undefined; } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  private waitUntil(done: () => boolean, untilMs: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>(resolve => {
      if (done() || signal.aborted || untilMs <= this.now()) { resolve(); return; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => { if (timer !== undefined) clearTimeout(timer); this.listeners.delete(check); signal.removeEventListener('abort', finish); resolve(); };
      const check = () => { if (done()) finish(); };
      this.listeners.add(check);
      signal.addEventListener('abort', finish, { once: true });
      timer = setTimeout(finish, Math.max(0, untilMs - this.now()));
    });
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

const NONE_TEXT = 'This routine publishes on x.com and no post was confirmed in this run. Post it once, or end with block and say why.';
const UNCONFIRMED_TEXT = 'X did not confirm the post you submitted and it is not on your profile yet. It may still have landed: do not post again; end with block.';
const rejectedText = (reason: string) => `X refused the post (${reason}). Nothing was published. Write different text (for a reply, choose another post: the same one will be held back) and post once, or end with block.`;

/** Section 6.9: a run that attempted a post ends with it confirmed, or with block. */
export function completionVerdict(records: readonly PublishRecord[], mustPublish: boolean):
  | { ok: true; record?: PublishRecord }
  | { ok: false; kind: 'none' | 'unconfirmed' | 'rejected'; message: string } {
  const confirmed = records.find(record => record.state === 'confirmed');
  if (confirmed) return { ok: true, record: confirmed };
  if (records.some(record => record.state === 'pending' || record.state === 'unobserved')) return { ok: false, kind: 'unconfirmed', message: UNCONFIRMED_TEXT };
  const rejected = [...records].reverse().find(record => record.state === 'rejected');
  if (rejected) return { ok: false, kind: 'rejected', message: rejectedText(rejected.reason ?? 'no reason given') };
  return mustPublish ? { ok: false, kind: 'none', message: NONE_TEXT } : { ok: true };
}

/**
 * The route handler's decision for one request (section 6.2 admission and admission failures).
 * GET, or an origin of no probe: continue without admit. refuse: PUBLISH_REFUSED, then abort.
 * track: PUBLISH_ATTEMPTED, then track (the caller continues the request and calls watch.track).
 * A throw from admit() or from the PUBLISH_ATTEMPTED insert: the admitted record is dropped, and the
 * request is aborted with PUBLISH_REFUSED {reason:'internal'} when it matched a probe or echoed a
 * noted fill (or when even that re-test throws). Only requests that match nothing continue.
 */
export function publishRouteDecision(input: { watch: PublishWatch; probes: readonly PublishProbe[]; req: PublishRequest; emit: (type: string, payload: unknown) => void }): PublishRouteDecision {
  const { watch, probes, req, emit } = input;
  if (req.method.toUpperCase() === 'GET') return { kind: 'continue' };
  const originProbe = probes.find(probe => probe.origins.includes(req.url.origin));
  if (!originProbe) return { kind: 'continue' };
  let admitted: AdmitResult | undefined;
  try {
    admitted = watch.admit(req);
    if (admitted.kind === 'pass') return { kind: 'continue' };
    if (admitted.kind === 'refuse') {
      const { reason, op, actionId, by, probe } = admitted;
      try { emit('PUBLISH_REFUSED', compact({ probe, op, reason, actionId, by })); } catch { /* refused either way: nothing is sent */ }
      if (admitted.character) { try { emit('CHARACTER_REFUSED', compact({ reason, ...admitted.character })); } catch { /* refused either way */ } }
      return { kind: 'abort', refusal: compact({ reason, op, actionId }) };
    }
    const attemptPayload = admitted.attempted;
    if (admitted.admission) admitted.admission.commitAttempt(admitted.record.publishId, () => emit('PUBLISH_ATTEMPTED', attemptPayload)); else emit('PUBLISH_ATTEMPTED', attemptPayload);
    return { kind: 'track', record: admitted.record };
  } catch {
    let recognized = true;
    if (admitted?.kind === 'track') { try { watch.dropAdmitted(admitted.record.publishId); } catch { /* the request is aborted either way */ } }
    else { try { recognized = watch.recognizes(req); } catch { recognized = true; } }
    if (!recognized) return { kind: 'continue' };
    try { emit('PUBLISH_REFUSED', { reason: 'internal', probe: originProbe.id, op: 'unknown', by: 'page' }); } catch { /* aborted either way */ }
    return { kind: 'abort', refusal: { reason: 'internal', op: 'unknown' } };
  }
}
