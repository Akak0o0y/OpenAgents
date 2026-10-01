import http from 'node:http';
import { once } from 'node:events';

/**
 * Stage 1 toggles of the X-shaped fixture (spec 11.4). They are read on every request, so a test may
 * change them mid-case. Stage 2 adds slowLoad, v2, ignoreFill, typeahead, anchorButton, anchorOnly,
 * twoComposers, swapTarget, silentPost and otherAccount.
 */
export interface XFixtureToggles {
  /** Every CreateTweet: 200 with errors[] code 187 and no post. */
  reject?: boolean;
  /** Only the first CreateTweet is refused that way. */
  rejectFirst?: boolean;
  /** 200 with errors[] code 999 and no create object; the post is created and listed. */
  unknownError?: boolean;
  /** The id sits in a visibility wrapper, with a warning in errors[]. */
  wrapped?: boolean;
  /** Never respond. */
  hang?: boolean;
  /** With hang: the received post is still listed on the profile pages. */
  listHung?: boolean;
  /** Delay every CreateTweet response by this many milliseconds. */
  holdMs?: number;
  /** 200 with an empty body; the post is created and listed. */
  noBody?: boolean;
  /** A new reply appears on its status page 6 s after the response instead of at once. */
  lateArticle?: boolean;
  /** Profile pages show "Loading…" for 3 s before their articles. */
  slowProfile?: boolean;
  /** After a post the composer keeps its text and the button stays enabled. */
  keepComposer?: boolean;
  /** The banner has no "Profile" link. */
  noProfileLink?: boolean;
  /** Input in the composer POSTs a draft echoing its text; a "Save draft" button POSTs it again. */
  echoDraft?: boolean;
  /** Received posts are shown with this text instead of their own (page-check mismatch cases). */
  shownText?: string;
  /** The page navigates to /home as soon as a post's response headers arrive, before its body is read (X's compose view closing). */
  leaveAfterPost?: boolean;
  /** Replies are not shown on their status page; only /fixture_bot/with_replies lists them (a page check then needs phase 2). */
  hideReplies?: boolean;
}

export interface XFixtureState {
  /** CreateTweet requests that reached this server. */
  requests: number;
  /** Posts created server-side, so listed on the pages. */
  posts: number;
  /** Receipt time (ms) of each CreateTweet request, in order. */
  receivedAt: number[];
  /** GETs of /fixture_bot and /fixture_bot/with_replies. */
  profileGets: number;
  /** CreateTweet responses written. */
  answered: number;
  /** Draft POSTs received. */
  drafts: number;
  /** Created posts, oldest first. */
  created: Array<{ id: string; text: string; inReplyTo?: string; at: number }>;
}

export interface XFixture {
  origin: string;
  state: XFixtureState;
  toggles: XFixtureToggles;
  /** Called when a CreateTweet request arrives, before it is answered. */
  onPost?: () => void;
  /** The path of timeline post k (1..7), for example /u3/status/<id>. */
  statusPath(k: number): string;
  close(): Promise<void>;
}

const SNOWFLAKE_EPOCH = 1288834974657n;
/** Timeline and pinned posts are from this fixed past time, so none falls inside a page check's window. */
const TIMELINE_MS = Date.UTC(2026, 8, 1);
const CREATE_PATH = '/i/api/graphql/q1/CreateTweet';
const DRAFT_PATH = '/i/api/1.1/drafts/autosave.json';
const HTML = 'text/html; charset=utf-8';
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (text: string) => text.replace(/[&<>"']/g, c => ESCAPES[c]!);

/** How X shows a post: a URL as a shortened display link, line breaks as <br>, a long text cut with "Show more". */
function shownHtml(text: string): string {
  const chars = [...text];
  const long = chars.length > 120;
  const visible = long ? chars.slice(0, 120).join('') : text;
  const html = visible.split(/(https?:\/\/\S+)/g).map((part, index) => {
    if (index % 2 === 0) return esc(part).replace(/\n/g, '<br>');
    const display = part.replace(/^https?:\/\/(www\.)?/, '');
    return `<a href="${esc(part)}">${esc(display.length > 19 ? display.slice(0, 19) + '…' : display)}</a>`;
  }).join('');
  return html + (long ? '…<span role="button">Show more</span>' : '');
}

function composerScript(cfg: { replyTo: string | null; keep: boolean; echo: boolean; lateMs: number; leave: boolean }): string {
  return `const cfg = ${JSON.stringify(cfg)};
const box = document.querySelector('.composer');
const send = document.querySelector('.send');
const draft = document.querySelector('.draft');
const typed = () => box.innerText.replace(/\\n$/, '');
const saveDraft = () => fetch('${DRAFT_PATH}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draft: { text: typed() } }) }).catch(() => {});
box.addEventListener('input', () => { send.disabled = typed().trim() === ''; if (cfg.echo) saveDraft(); });
if (draft) draft.addEventListener('click', saveDraft);
document.querySelector('.refresh').addEventListener('click', () => { document.body.dataset.refreshed = String(Date.now()); });
const refresh = () => fetch('/fixture_api/replies/' + cfg.replyTo).then(r => r.text()).then(html => { document.querySelector('.conversation').innerHTML = html; }).catch(() => {});
send.addEventListener('click', () => {
  const variables = { tweet_text: typed(), media: { media_entities: [], possibly_sensitive: false }, semantic_annotation_ids: [] };
  if (cfg.replyTo) variables.reply = { in_reply_to_tweet_id: cfg.replyTo, exclude_reply_user_ids: [] };
  if (!cfg.keep) send.disabled = true;
  // No await before fetch: the request leaves while the click is still being dispatched.
  fetch('${CREATE_PATH}?fixture=query-marker-7Q', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ variables, features: { fixture_feature: true }, queryId: 'q1' }) })
    .then(response => { if (cfg.leave) { location.assign('/home'); return ''; } if (!cfg.keep) { box.textContent = ''; send.disabled = true; } if (cfg.replyTo) setTimeout(refresh, cfg.lateMs); return response.text(); })
    .catch(() => { if (!cfg.keep) send.disabled = typed().trim() === ''; });
});`;
}

/** A local node http server shaped like x.com (spec 11.4). No request ever leaves 127.0.0.1. */
export async function xFixture(initial: XFixtureToggles = {}): Promise<XFixture> {
  let sequence = 0;
  const snowflake = (ms: number) => String(((BigInt(ms) - SNOWFLAKE_EPOCH) << 22n) | BigInt(sequence++ & 0xfff));
  const timeline = Array.from({ length: 7 }, (_, index) => ({ k: index + 1, id: snowflake(TIMELINE_MS + (index + 1) * 60_000) }));
  const pinnedId = snowflake(TIMELINE_MS);
  const toggles: XFixtureToggles = { ...initial };
  const state: XFixtureState = { requests: 0, posts: 0, receivedAt: [], profileGets: 0, answered: 0, drafts: 0, created: [] };
  const hung = new Set<http.ServerResponse>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  // Every response closes its connection. The local egress proxy (browser-egress.ts) reuses upstream sockets through
  // Node's global agent, whose 5 s socket timeout cuts a held answer on a reused socket short with a 502.
  const send = (res: http.ServerResponse, status: number, type: string, body: string) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', connection: 'close' }); res.end(body); };
  const read = (req: http.IncomingMessage) => new Promise<string>(resolve => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
  const page = (title: string, main: string, script = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{margin:0;font:14px sans-serif}
header{position:absolute;left:0;top:0;width:200px}
main{position:absolute;left:220px;top:0;width:860px;min-height:700px}
.composer{position:absolute;left:0;top:10px;width:560px;height:80px;border:1px solid #888;white-space:pre-wrap;overflow:auto}
.send{position:absolute;left:0;top:100px;width:120px;height:40px}
.refresh{position:absolute;left:140px;top:100px;width:120px;height:40px}
.draft{position:absolute;left:280px;top:100px;width:120px;height:40px}
.feed{position:absolute;left:0;top:160px;width:580px}
.profile{position:absolute;left:0;top:10px;width:580px}
</style></head><body><header role="banner"><nav><a href="/compose/post">Post</a><br>${toggles.noProfileLink ? '' : '<a href="/fixture_bot" aria-label="Profile">Profile</a><br>'}<a href="/home">Home</a></nav></header><main>${main}</main><script>${script}</script></body></html>`;
  const composer = (button: 'Post' | 'Reply') => '<div class="composer" role="textbox" aria-label="Post text" contenteditable="true"></div>'
    + `<button class="send" disabled>${button}</button><button class="refresh" type="button">Refresh</button>`
    + (toggles.echoDraft ? '<button class="draft" type="button">Save draft</button>' : '');
  const script = (replyTo: string | null) => composerScript({ replyTo, keep: !!toggles.keepComposer, echo: !!toggles.echoDraft, lateMs: toggles.lateArticle ? 6000 : 0, leave: !!toggles.leaveAfterPost });
  const timelineArticle = (k: number, id: string) => `<article><a href="/u${k}">User ${k}</a> <a href="/u${k}/status/${id}">2h</a><div class="text">Timeline post ${k}: a fixture thought about testing, number ${k}.</div></article>`;
  const ownArticle = (post: { id: string; text: string }) => `<article><a href="/fixture_bot">Fixture Bot</a> <a href="/fixture_bot/status/${post.id}">now</a><div class="text">${shownHtml(toggles.shownText ?? post.text)}</div></article>`;
  const pinned = `<article><a href="/fixture_bot">Fixture Bot</a> <a href="/fixture_bot/status/${pinnedId}">Sep 1</a><div class="text">Pinned: welcome to the fixture profile.</div></article>`;
  const newestFirst = (filter: (post: XFixtureState['created'][number]) => boolean) => [...state.created].reverse().filter(filter).map(ownArticle).join('');
  const repliesTo = (id: string) => toggles.hideReplies ? '' : newestFirst(post => post.inReplyTo === id);

  const home = () => page('Home / X fixture', composer('Post') + `<section class="feed">${timeline.map(({ k, id }, index) => (index === 3 ? '<article><span>Ad</span><div class="text">A sponsored fixture message without a status link.</div></article>' : '') + timelineArticle(k, id)).join('')}</section>`, script(null));
  const status = (user: string, id: string) => {
    const target = timeline.find(post => `u${post.k}` === user && post.id === id);
    const own = user === 'fixture_bot' ? state.created.find(post => post.id === id) : undefined;
    const article = target ? timelineArticle(target.k, target.id) : own ? ownArticle(own) : '<article><div class="text">This post is unavailable.</div></article>';
    return page('Post / X fixture', composer('Reply') + `<section class="feed"><div class="target">${article}</div><div class="conversation">${repliesTo(id)}</div></section>`, script(id));
  };
  const profile = (withReplies: boolean) => {
    const list = newestFirst(post => withReplies || !post.inReplyTo) + pinned;
    if (!toggles.slowProfile) return page('Fixture Bot / X fixture', `<section class="profile">${list}</section>`);
    return page('Fixture Bot / X fixture', `<section class="profile"><div id="loading">Loading…</div><template id="later">${list}</template></section>`,
      "setTimeout(() => { document.querySelector('#loading').replaceWith(document.querySelector('#later').content.cloneNode(true)); }, 3000);");
  };

  const createTweet = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const receivedAt = Date.now();
    state.requests++; state.receivedAt.push(receivedAt);
    const number = state.requests;
    void read(req).then(raw => {
      fixture.onPost?.();
      let text = ''; let inReplyTo: string | undefined;
      try {
        const parsed = JSON.parse(raw) as { variables?: { tweet_text?: unknown; reply?: { in_reply_to_tweet_id?: unknown } } };
        text = typeof parsed.variables?.tweet_text === 'string' ? parsed.variables.tweet_text : '';
        const target = parsed.variables?.reply?.in_reply_to_tweet_id;
        inReplyTo = typeof target === 'string' ? target : undefined;
      } catch { /* an unparseable body still gets an answer below */ }
      const rejected = !!toggles.reject || (!!toggles.rejectFirst && number === 1);
      const id = snowflake(receivedAt);
      if (!rejected && (!toggles.hang || toggles.listHung)) { state.posts++; state.created.push({ id, text, ...(inReplyTo ? { inReplyTo } : {}), at: receivedAt }); }
      if (toggles.hang) { hung.add(res); return; }
      const answer = () => {
        const body = rejected ? { errors: [{ code: 187, message: 'Status is a duplicate. (187)' }] }
          : toggles.unknownError ? { errors: [{ code: 999, message: 'Fixture unknown error.' }], data: {} }
          : toggles.wrapped ? { data: { create_tweet: { tweet_results: { result: { __typename: 'TweetWithVisibilityResults', tweet: { rest_id: id, legacy: { full_text: text } } } } } }, errors: [{ code: 214, message: 'Fixture warning.' }] }
          : { data: { create_tweet: { tweet_results: { result: { __typename: 'Tweet', rest_id: id, legacy: { full_text: text, ...(inReplyTo ? { in_reply_to_status_id_str: inReplyTo } : {}) } } } } } };
        send(res, 200, 'application/json', toggles.noBody && !rejected ? '' : JSON.stringify(body));
        state.answered++;
      };
      if (toggles.holdMs) { const timer = setTimeout(() => { timers.delete(timer); answer(); }, toggles.holdMs); timers.add(timer); }
      else answer();
    });
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture.invalid');
    if (req.method === 'POST' && url.pathname === CREATE_PATH) { createTweet(req, res); return; }
    if (req.method === 'POST' && url.pathname === DRAFT_PATH) { state.drafts++; void read(req).then(() => send(res, 200, 'application/json', '{}')); return; }
    if (req.method !== 'GET') { send(res, 405, 'text/plain', 'Method not allowed.'); return; }
    if (url.pathname === '/' || url.pathname === '/home' || url.pathname === '/compose/post') { send(res, 200, HTML, home()); return; }
    if (url.pathname === '/fixture_bot' || url.pathname === '/fixture_bot/with_replies') { state.profileGets++; send(res, 200, HTML, profile(url.pathname.endsWith('/with_replies'))); return; }
    const replies = /^\/fixture_api\/replies\/(\d+)$/.exec(url.pathname);
    if (replies) { send(res, 200, HTML, repliesTo(replies[1])); return; }
    const post = /^\/(u\d|fixture_bot)\/status\/(\d+)$/.exec(url.pathname);
    if (post) { send(res, 200, HTML, status(post[1], post[2])); return; }
    send(res, 404, 'text/plain', 'Not found.');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const fixture: XFixture = {
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    state, toggles,
    statusPath: k => { const post = timeline[k - 1]; if (!post) throw new Error(`The fixture timeline has posts 1 to ${timeline.length}.`); return `/u${post.k}/status/${post.id}`; },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear(); hung.clear();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
  return fixture;
}
