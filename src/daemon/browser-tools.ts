import { chromium, type Browser, type BrowserContext, type Page, type Route, type Locator } from 'playwright';
import {FlowMiss,FlowAccountChanged,CommitRejected,CommitNotSent,type RecordedStep,type ElementIdentity,type FlowTarget,type PlayStep,type PlayResult} from './flow-types.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {GoalResults,contentDigest} from './goal-results.js';
import {whatsappSnapshot,whatsappTarget,matchWhatsAppReceipt} from './whatsapp-receipts.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentStore } from './agent-store.js';
import { ArtifactStore, MAX_BROWSER_DOWNLOAD_BYTES } from './artifacts.js';
import type { ApprovalGate } from './control-plane.js';
import type { SecretStore } from './secret-store.js';
import { RunCapacity } from './run-capacity.js';
import { browserEgress } from './browser-egress.js';
import { loginUrl, unfinishedLogin, rejectedGoogleLogin } from './browser-login.js';
import { browserAutonomy, siteMatches, type BrowserAccounts } from './browser-accounts.js';
import type { BrowserSandbox } from './browser-sandbox.js';
import type { BotDesktop } from './bot-desktop.js';
import { computerAction, type ComputerAction } from './computer-actions.js';
import type { ChatImage } from '../evals/llm-client.js';
import { PublishWatch, publishRouteDecision, type PublishAttempted, type PublishRecord, type RunPolicy } from './browser-publish.js';
import { matchesPostText, snowflakeMs, textSha256, normalizeEcho, statusIdOf, type ProbedRequest, type PublishProbe } from './publish-probes.js';

const target = z.object({
  ref: z.string().regex(/^[a-z0-9]+$/).max(40).optional(),
  role: z.enum(['file', 'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption', 'cell', 'checkbox', 'code', 'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition', 'deletion', 'dialog', 'directory', 'document', 'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img', 'insertion', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'meter', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'navigation', 'none', 'note', 'option', 'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'strong', 'subscript', 'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem']).optional(),
  name: z.string().max(300).optional(), index: z.number().int().min(0).max(500).default(0), frame: z.number().int().min(0).max(50).optional(),
}).strict();
export const browserAction = z.object({ tool: z.literal('browser'), action: z.enum(['navigate', 'snapshot', 'click', 'double_click', 'right_click', 'hover', 'drag', 'scroll', 'press', 'select', 'check', 'fill', 'screenshot', 'download', 'upload', 'tabs', 'new_tab', 'use_tab', 'close_tab']),
  destination: target.optional(), checked: z.boolean().optional(), deltaX: z.number().min(-3000).max(3000).optional(), deltaY: z.number().min(-3000).max(3000).optional(),
  key: z.string().max(100).regex(/^(?:(?:Alt|Control|ControlOrMeta|Meta|Shift)\+)*(?:[A-Za-z0-9]|F(?:[1-9]|1[0-2])|Enter|Escape|Tab|Space|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)$/).optional(),
  url: z.string().url().max(4000).optional(), target: target.optional(), value: z.string().max(8000).optional(), tab: z.number().int().min(0).max(7).optional(), artifactId: z.string().max(100).optional(), sourceRunId: z.string().max(100).optional(),
  /** Upload a file from the bot's own computer, such as one it downloaded into ~/Downloads.
   * Without this the only uploadable source was a stored artifact, so a file sitting on the
   * bot's own desktop could not be attached to a page at all. */
  desktopPath: z.string().max(4096).optional()
    .describe("For upload: a file on this bot's own computer, such as \"Downloads/banner.png\". Use this to attach a file the bot downloaded or created; use artifactId with sourceRunId only for a stored artifact."),
  /** Type a saved account's detail instead of a value; the model never sees it. See browser-accounts.ts. */
  secret: z.enum(['username', 'password']).optional(), account: z.string().max(100).optional() }).strict();
export type BrowserAction = z.infer<typeof browserAction>;
/** Chromium flags for every session, local or sandboxed: no traffic may leave outside the proxy. */
const BROWSER_ARGS = ['--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];
type BrowserIsolation = 'sandbox' | 'computer';
const UNCERTAIN_BROWSER_EFFECT = 'Browser interaction outcome is uncertain. Inspect the page and action history; do not repeat the submission automatically.';
const OPERATOR_ACTED = 'The operator interacted with this page. Take a fresh browser snapshot and check what changed before acting. Do not repeat a submission the operator may have completed.';
/** A dispatched browser action whose outcome is unknown (spec 6.11). Every /outcome is uncertain/ consumer matches this exact text. */
export class UncertainExternalEffect extends Error { constructor() { super(UNCERTAIN_BROWSER_EFFECT); } }
/** The bot's browser, or the browser capacity, is held by another run (spec 6.11). */
export class BrowserBusy extends Error {}
/** withLease({ reuseOnly }) found no live session: close-out and the page check never start one. */
class NoSession extends Error { constructor() { super('This run has no open browser session.'); } }
/** How long a click waits for its request to reach the route before judging that it sent none. */
const PUBLISH_ATTRIBUTION_GRACE_MS = 500;
/** The call result's publish field (spec 6.3). */
export interface PublishField { state: PublishRecord['state'] | 'refused'; op: string; postUrl?: string; reason?: string }
const PAGE_CHECK_NAVIGATED = 'The page was changed to check a post. Take a fresh browser snapshot before acting.';
/** Rejects with the signal's reason if it aborts first; the promise itself keeps running. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { promise.catch(() => {}); reject(signal.reason); return; }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', onAbort); resolve(value); }, error => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}
const pause = (ms: number, signal: AbortSignal) => raceAbort(delay(ms), signal);
/** In memory only (spec 8.5). It outlives the browser session; Stage 2 adds the trace and expectedAccount. */
interface RunRecord { policy?: RunPolicy; watch: PublishWatch; ephemeral: boolean; trace:RecordedStep[];traceOverflow?:boolean;expectedAccount?:string }
interface FlowOptions {target:FlowTarget;fillMethod?:'fill'|'insertText';commit?:Extract<PlayStep,{kind:'commit'}>;pick?:{container:string;pattern:string;max:number};dispatchedAt?:number}
/** Resolves when the promise settles, or rejects with the signal's reason if the signal aborts first. */
function settledOrAborted(promise: Promise<unknown>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(() => undefined, () => undefined).then(() => { signal.removeEventListener('abort', onAbort); resolve(); });
  });
}
interface LoginRun {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  saved: boolean;
  opening?: Promise<unknown>;
}
interface Session { browser: Browser; context: BrowserContext; page: Page; agentId: string; runId: string; writes: Set<string>; release: () => void; proxy: { close(): Promise<void> }; signal: AbortSignal; abort: () => void; idle?: ReturnType<typeof setTimeout>;
  /** Where Chromium runs: a Docker sandbox (browser-sandbox.ts) or this computer. */
  isolation: BrowserIsolation;
  desktop?: boolean;
  /**
   * Chrome writes downloads onto the desktop container's filesystem, which this daemon cannot
   * read. Downloads are named by GUID there (Browser.setDownloadBehavior allowAndName) and
   * fetched back through the authenticated gateway.
   */
  desktopDownloads?: Map<string, { suggestedFilename: string; state: string }>;
  fetchDesktopDownload?: (name: string) => Promise<Buffer>;
  /** Read any file from the bot's own computer, for uploading it to a page. Separate from
   * desktopCall so it can run while a browser action already holds the interaction lease. */
  readDesktopFile?: (desktopPath: string) => Promise<Buffer>;
  /** Account details typed in this session, replaced before any page text reaches the model or the event log. */
  typed: Map<string, string>;
  /** The run's publish policy and watch (spec 6.3 item 3), shared with the route handler registered before this Session existed. */
  run: RunRecord;
  /** Why the next action must observe first (requireFreshObservation). Unset means the operator acted. */
  observationReason?: string;
  /** Deferred teardown (spec 6.10): endRun after 30 s while a post is unresolved. */
  teardownTimer?: ReturnType<typeof setTimeout>;
  controlled?: boolean;
  actionDone?: Promise<void>;
  operatorDone?: Promise<unknown>;
  resume?: () => void;
  frame?: Promise<unknown>;
  loginSite?: string;
  navigationError?: string;
  needsObservation?: boolean;
  refs?: Set<string>;
  computerScreen?: { width: number; height: number; observedAt: number };
  controlEnded?: Error;
  lastScreenshot?: Buffer | null;
  lastState?: { url: string; title: string; tabs: Array<{ index: number; url: string }>; screenshot?: string;
    /** The redacted page text the model read, so a wrong click can be explained afterwards. */
    snapshot?: string;
    action?: string; target?: string; timestamp?: number } }

/** Playwright API adapter with per-run contexts, encrypted per-bot state and a DNS-pinning egress proxy. */
export class BrowserTools {
  private sessions = new Map<string, Session>();
  private opening = new Set<string>();
  private closing = new Map<string, Promise<void>>();
  private pendingOpen = new Set<Promise<Session>>();
  private lifetime = new AbortController();
  private capacity: RunCapacity;
  private installing = false;
  private installError: string | null = null;
  private loginRuns = new Map<string, string>();
  private loginJobs = new Map<string, LoginRun>();
  private humanDesktops = new Map<string, { agentId: string; url: string; site: string; release: () => void; ready: boolean }>();
  private stateErrors = new Map<string, string>();
  private viewerRevocations = new Map<string, Set<() => void>>();
  /** Run records by run id: from setRunPolicy, or ephemeral for a session opened without one. */
  private runs = new Map<string, RunRecord>();
  /** 1-based session-open attempts per run, counted only when testHooks.beforeOpen is set. */
  private openAttempts = new Map<string, number>();
  constructor(private options: { store: AgentStore; artifacts: ArtifactStore; secrets: SecretStore; approvals?: ApprovalGate; accounts?: BrowserAccounts; maxBrowsers?: number; previewOrigins?: string[]; enabled?: boolean; headed?: boolean;
    desktop?: BotDesktop;
    /** Human sign-in is bounded even if its UI disappears (default 30 minutes). */
    loginTimeoutMs?: number;
    /** Sweep abandoned sessions; a running task owns its browser until cancellation or endRun. */
    idleTimeoutMs?: number;
    /** The Docker sandbox, when this installation has one. */
    sandbox?: Pick<BrowserSandbox, 'endpoint' | 'status' | 'markBroken'>;
    /** auto: the sandbox when ready, else this computer. sandbox: only the sandbox. computer: never the sandbox. */
    isolation?: 'auto' | 'sandbox' | 'computer';
    /** Site knowledge for publish requests (spec 6.1). Without it the route handler is exactly today's. */
    publishProbes?: PublishProbe[];
    /** Test and verifier seam only: answers routes of one origin inside the browser. Production passes none. */
    fixtureRoutes?: { origin: string; handle(route: Route): Promise<boolean> };
    /** Test seams only. afterDispatch runs right after a dispatch returns, inside its try; beforeOpen at the start of openSession's desktop branch. */
    testHooks?: { afterDispatch?: (actionId: string, action: string) => Promise<void>; beforeOpen?: (runId: string, attempt: number) => Promise<void>; fixtureExecutablePath?:string } }) {
    this.capacity = new RunCapacity(options.maxBrowsers ?? 2);
    options.store.getDatabase().exec('CREATE TABLE IF NOT EXISTS browser_sessions(agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,ciphertext TEXT NOT NULL,updated_at INTEGER NOT NULL)');
  }
  status(agentId?: string) { const sandboxed = !!this.sandboxEndpoint();
    return { enabled: this.options.enabled !== false, computerEnabled: this.options.enabled !== false && !!this.options.desktop, ready: this.options.desktop ? this.options.desktop.provisionStatus().state === 'ready' : sandboxed || fs.existsSync(chromium.executablePath()), installing: this.installing, error: this.installError,
    ...(this.options.desktop ? { desktopSetup: this.options.desktop.provisionStatus() } : {}),
    ...(this.options.desktop ? { desktop: agentId ? this.options.desktop.status(agentId) : { state: 'stopped', message: 'Bot desktops start on demand.' } } : {}),
    isolation: (this.options.desktop || sandboxed ? 'sandbox' : 'computer') as BrowserIsolation, sandbox: this.options.isolation === 'computer' ? null : this.options.sandbox?.status() ?? null,
    active: this.capacity.used, limit: this.capacity.limit, sessions: [...[...this.sessions.values()].filter(s => !agentId || s.agentId === agentId).map(s => ({ agentId: s.agentId, runId: s.runId, url: this.redact(s, s.page.url()), login: this.loginRuns.get(s.agentId) === s.runId, isolation: s.isolation })), ...[...this.humanDesktops].filter(([, s]) => s.ready && (!agentId || s.agentId === agentId)).map(([runId, s]) => ({ agentId: s.agentId, runId, url: s.url, login: true, isolation: 'sandbox' as BrowserIsolation }))], persistenceErrors: Object.fromEntries([...this.stateErrors].filter(([id]) => !agentId || id === agentId)),
    // Sites and labels only: no response and no prompt ever carries an account's details.
    ...(agentId && this.options.store.getAgent(agentId) ? { connections: this.connections(agentId), autonomy: browserAutonomy(this.options.store, agentId), accounts: (this.options.accounts?.list(agentId) ?? []).map(({ id, site, label, updatedAt }) => ({ id, site, label, updatedAt })) } : {}) }; }

  /**
   * The sandbox to use for a model session, if any. Preview origins are
   * services on this computer, which a container cannot reach, so a daemon
   * that serves them keeps its browser local.
   */
  private sandboxEndpoint() {
    if (this.options.isolation === 'computer' || this.options.previewOrigins?.length) return null;
    return this.options.sandbox?.endpoint() ?? null;
  }

  /** Whether this bot may submit forms on a host without asking, by its autonomy setting (see browser-accounts.ts). */
  private autonomyAllows(agentId: string, hostname: string): false | 'always' | 'accounts' {
    const autonomy = browserAutonomy(this.options.store, agentId);
    if (autonomy === 'always') return 'always';
    return autonomy === 'accounts' && (this.options.accounts?.hasSite(agentId, hostname) || this.connections(agentId).some(c => siteMatches(c.site, hostname))) ? 'accounts' : false;
  }

  connections(agentId: string): Array<{ site: string; verified: boolean; updatedAt: number }> {
    return (this.options.store.getDatabase().prepare("SELECT data_json FROM agent_data WHERE agent_id=? AND category='browser-connection'").all(agentId) as { data_json: string }[])
      .map(row => JSON.parse(row.data_json))
      .filter(connection => !this.options.desktop || connection.environment === 'bot-desktop-v1');
  }

  private redact(session: Session, text: string): string {
    let result = text;
    for (const [secret, label] of session.typed) if (secret) result = result.split(secret).join(label);
    return result;
  }

  /** Nonblocking first-use setup for the operator's HTTP action. */
  async beginLogin(agentId: string, value: string) {
    if (!this.options.store.getAgent(agentId)) throw new Error('Unknown bot.');
    loginUrl(value);
    if (this.options.enabled === false) throw new Error('Browser tools are disabled.');
    if (this.options.desktop && this.options.desktop.provisionStatus().state !== 'ready') {
      this.install();
      return { opened: false, preparing: true, desktop: true };
    }
    return this.openLogin(agentId, value);
  }
  /** An authenticated operator opens this window; the model cannot call this method or enter account credentials. */
  async openLogin(agentId: string, value: string) {
    if (!this.options.store.getAgent(agentId)) throw new Error('Unknown bot.');
    if (this.options.enabled === false) throw new Error('Browser tools are disabled.');
    this.lifetime.signal.throwIfAborted();
    const url = loginUrl(value);
    if (this.loginRuns.has(agentId)) throw new Error('A login window is already open for this bot.');
    if (this.opening.has(agentId) || [...this.sessions.values()].some(s => s.agentId === agentId)) throw new Error('Finish the bot’s current browser task before signing in.');
    const run = this.options.store.createTaskRun({ agentId, taskName: 'browser-login' });
    this.options.store.startTaskRun(run.id, this.options.store.getAgent(agentId)!.model_id);
    this.loginRuns.set(agentId, run.id);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void this.cancelLogin(agentId, run.id, 'Login session timed out.').catch(error => this.stateErrors.set(agentId, String(error.message ?? error)));
    }, this.options.loginTimeoutMs ?? 30 * 60_000);
    timer.unref();
    const job: LoginRun = { controller, timer, saved: false };
    this.loginJobs.set(run.id, job);
    const pending = this.openLoginRun(agentId, run.id, url, job);
    job.opening = pending;
    return pending;
  }
  private async openLoginRun(agentId: string, runId: string, url: URL, job: LoginRun) {
    const signal = AbortSignal.any([job.controller.signal, this.lifetime.signal]);
    try {
      if (this.options.desktop) {
        const release = this.capacity.acquire(runId);
        if (!release) throw new Error('Browser capacity is full. Retry after another browser task finishes.');
        const human = { agentId, url: url.href, site: url.hostname, release, ready: false };
        this.humanDesktops.set(runId, human);
        await this.options.desktop.beginHumanLogin(agentId, url.href);
        signal.throwIfAborted();
        human.ready = true;
        this.stateErrors.delete(agentId);
        return { opened: true, runId, desktop: true, warning: 'You are signing in directly in Chrome. The bot is disconnected until you save or cancel.' };
      }
      if (!this.options.desktop && !(await this.options.secrets.availability()).available) throw new Error('Protected session storage is unavailable on this computer.');
      signal.throwIfAborted();
      if (!this.options.desktop && !fs.existsSync(chromium.executablePath())) {
        this.install();
        while (this.installing) { signal.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, 250)); }
        if (!fs.existsSync(chromium.executablePath())) throw new Error(this.installError ?? 'The sign-in browser could not be prepared. Please try again.');
      }
      const s = await this.open(agentId, runId, signal, true);
      signal.throwIfAborted();
      s.loginSite = url.hostname;
      this.stateErrors.delete(agentId);
      clearTimeout(s.idle); // The bounded human deadline replaces the shorter model idle timer.
      s.writes.add('*'); // Only the human-controlled login context gets this grant. New model contexts start empty.
      // A slow/blocked navigation must not destroy the window containing the user's login.
      try { await s.page.goto(url.href, { waitUntil: 'domcontentloaded' }); }
      catch { s.navigationError = 'The website did not finish loading. The sign-in window is still open; retry there or use another sign-in address.'; }
      signal.throwIfAborted();
      if (!this.sessions.has(runId) || this.closing.has(runId)) throw new Error('The sign-in window was closed.');
      return { opened: true, runId, warning: s.navigationError, ...(s.desktop ? { desktop: true } : {}) };
    } catch (error) {
      try { await this.endRun(runId); }
      finally { this.finishLoginRun(agentId, runId, signal.aborted ? 'ABORTED' : 'FAILED', signal.aborted ? String(signal.reason?.message ?? 'Sign-in cancelled.') : 'Login window could not open.'); }
      throw error;
    }
  }
  private finishLoginRun(agentId: string, runId: string, status: 'ABORTED' | 'FAILED' | 'COMPLETED', message?: string) {
    const job = this.loginJobs.get(runId);
    if (job) clearTimeout(job.timer);
    this.loginJobs.delete(runId);
    if (this.loginRuns.get(agentId) === runId) this.loginRuns.delete(agentId);
    if (this.options.store.getTaskRun(runId)?.status === 'RUNNING') this.options.store.finishTaskRun(runId, status, message);
  }
  /** Run-scoped and idempotent: a stale UI cannot close a newer login. */
  async cancelLogin(agentId: string, runId: string, message = 'Sign-in cancelled.') {
    const job = this.loginJobs.get(runId);
    if (!job || this.loginRuns.get(agentId) !== runId) return { cancelled: false };
    job.controller.abort(new Error(message));
    this.revokeDesktop(agentId);
    try {
      await job.opening?.catch(() => {});
      await this.endRun(runId);
    } finally { this.finishLoginRun(agentId, runId, 'ABORTED', message); }
    if (this.stateErrors.has(agentId)) throw new Error(this.stateErrors.get(agentId));
    return { cancelled: true };
  }
  async cancelLoginRun(runId: string) {
    const agentId = [...this.loginRuns].find(([, id]) => id === runId)?.[0];
    return agentId ? (await this.cancelLogin(agentId, runId)).cancelled : false;
  }
  async finishLogin(agentId: string, expectedRunId?: string) {
    const runId = this.loginRuns.get(agentId); if (!runId) throw new Error('No login session is open for this bot.');
    if (expectedRunId && runId !== expectedRunId) throw new Error('That login session is no longer open.');
    const job = this.loginJobs.get(runId)!;
    job.controller.signal.throwIfAborted();
    const human = this.humanDesktops.get(runId);
    if (human) {
      if (!human.ready || this.closing.has(runId)) throw new Error('Wait for the sign-in desktop to finish opening.');
      // No debugger, DOM inspection or cookie export during human sign-in.
      // Save is the operator's confirmation, never a claim of account verification.
      await this.options.desktop!.finishHumanLogin(agentId);
      job.controller.signal.throwIfAborted();
      this.options.store.setAgentData({ agentId, taskRunId: runId, category: 'browser-connection', key: human.site, data: { site: human.site, verified: false, updatedAt: Date.now(), environment: 'bot-desktop-v1' } });
      job.saved = true;
      await this.endRun(runId);
      return { saved: true, site: human.site, verified: false };
    }
    const session = this.sessions.get(runId);
    if (!session?.loginSite) throw new Error('The sign-in window was closed. Open it again to save a session.');
    const site = session.loginSite;
    if (session.context.pages().some(p => rejectedGoogleLogin(p.url()))) throw new Error('Google rejected this sign-in browser. Close the rejected Google popup and use the website’s direct sign-in option if available. OpenAgents cannot override Google’s browser restrictions.');
    const page = [...session.context.pages()].reverse().find(p => { try { return siteMatches(site, new URL(p.url()).hostname); } catch { return false; } });
    if (!page) throw new Error('Return to the requested website after signing in, then save the session.');
    // GitHub supplies an authenticated identity marker. Other websites remain explicitly
    // user-confirmed until the bot checks access during the requested task.
    const verified = site === 'github.com' && !!(await page.locator('meta[name="user-login"]').getAttribute('content').catch(() => null));
    if (site === 'github.com' && !verified) throw new Error('GitHub has not confirmed a signed-in account yet. Finish signing in and try again.');
    if (unfinishedLogin(page.url())) throw new Error('Sign-in is not complete. Finish in the browser before saving.' + (['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(site) ? ' If X says login is temporarily limited, wait before trying again; OpenAgents cannot remove that restriction.' : ''));
    // Persist before closing. Failure leaves the human window open for a retry.
    try { await this.saveSession(session); }
    catch (error) {
      const message = error instanceof Error ? error.message : 'Browser session could not be saved.';
      this.stateErrors.set(agentId, message);
      throw new Error(`${message} The sign-in window is still open; you can retry saving.`);
    }
    job.controller.signal.throwIfAborted();
    job.saved = true;
    await this.endRun(runId);
    job.controller.signal.throwIfAborted();
    if (this.stateErrors.has(agentId)) throw new Error(this.stateErrors.get(agentId));
    this.options.store.setAgentData({ agentId, taskRunId: runId, category: 'browser-connection', key: site, data: { site, verified, updatedAt: Date.now(), ...(this.options.desktop ? { environment: 'bot-desktop-v1' } : {}) } });
    return { saved: true, site, verified };
  }
  disconnect(agentId: string) {
    if (this.options.desktop) throw new Error('Sign out inside this bot’s Chrome to remove an account. Its persistent profile is not a copied browser session.');
    if ([...this.sessions.values()].some(s => s.agentId === agentId) || this.opening.has(agentId)) throw new Error('Finish the active browser run before disconnecting.');
    this.options.store.getDatabase().prepare('DELETE FROM browser_sessions WHERE agent_id=?').run(agentId);
    this.options.store.getDatabase().prepare("DELETE FROM agent_data WHERE agent_id=? AND category='browser-connection'").run(agentId);
    this.stateErrors.delete(agentId);
    return { disconnected: true };
  }

  /** Operator-only setup route calls this; no model tool can install dependencies. */
  install() {
    if (this.installing) return this.status();
    if (this.options.desktop) {
      this.installing = true; this.installError = null;
      void this.options.desktop.ensureImage().catch(error => { this.installError = error instanceof Error ? error.message : 'Bot desktop setup failed.'; })
        .finally(() => { this.installing = false; });
      return this.status();
    }
    this.installing = true; this.installError = null;
    // Use the runtime-only CLI: the full Playwright CLI imports its test/MCP runner,
    // whose test directories are intentionally not shipped by the desktop packager.
    const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('playwright-core/package.json')), 'cli.js');
    const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
    for (const key of ['PATH', 'SystemRoot', 'USERPROFILE', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOME']) if (process.env[key]) env[key] = process.env[key];
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); this.installError = 'Browser installation timed out. Try again with a working connection.'; }, 300000);
    child.stderr.resume();
    child.once('error', () => { clearTimeout(timer); this.installing = false; this.installError = 'Browser installer could not start.'; });
    child.once('close', code => { clearTimeout(timer); this.installing = false; if (code && !this.installError) this.installError = `Browser installation failed (exit ${code}). Check network access and disk space.`; });
    return this.status();
  }

  private open(agentId: string, runId: string, signal: AbortSignal, headed = this.options.headed ?? false) {
    const pending = this.openSession(agentId, runId, AbortSignal.any([signal, this.lifetime.signal]), headed);
    this.pendingOpen.add(pending);
    void pending.finally(() => this.pendingOpen.delete(pending)).catch(() => {});
    return pending;
  }
  private async openSession(agentId: string, runId: string, signal: AbortSignal, headed: boolean) {
    const humanLogin = this.loginJobs.has(runId);
    signal.throwIfAborted();
    if (this.options.enabled === false) throw new Error('Browser tools are disabled.');
    const existing = this.sessions.get(runId); if (existing) { this.armIdleCleanup(existing); return existing; }
    // The human sign-in window is a real window on this computer; everything else prefers the sandbox.
    const desktop = this.options.desktop;
    const remote = headed || desktop ? null : this.sandboxEndpoint();
    if (!desktop && !headed && !remote && this.options.isolation === 'sandbox') throw new Error(`The sandboxed browser is not ready: ${this.options.sandbox?.status().message ?? 'Docker is not configured in this installation.'}`);
    const fixtureExecutable=this.options.fixtureRoutes?this.options.testHooks?.fixtureExecutablePath:undefined;
    if (!desktop && !remote && !fs.existsSync(fixtureExecutable??chromium.executablePath())) throw new Error('The managed browser is not installed. Use Install browser in the bot system panel.');
    if (this.opening.has(agentId) || [...this.sessions.values()].some(s => s.agentId === agentId) || [...this.humanDesktops.values()].some(s => s.agentId === agentId)) throw new BrowserBusy('This bot already has a browser session in another run. Wait for it to finish.');
    const release = this.capacity.acquire(runId); if (!release) throw new BrowserBusy('Browser capacity is full. Retry in a later bounded run.');
    this.opening.add(agentId);
    let browser: Browser | undefined, proxy: { close(): Promise<void> } | undefined;
    let desktopEndpoint: { base: string; token: string } | undefined;
    let createdRun: RunRecord | undefined;
    try {
      // The route handler is registered before the Session exists (391 vs 409), so the run record is resolved here (spec 6.3 item 3).
      if (!this.runs.has(runId)) { createdRun = this.newRunRecord(runId, agentId, undefined, true); this.runs.set(runId, createdRun); }
      const runRecord = this.runs.get(runId)!;
      signal.throwIfAborted();
      if (desktop) {
        if (this.options.testHooks?.beforeOpen) {
          const attempt = (this.openAttempts.get(runId) ?? 0) + 1;
          this.openAttempts.set(runId, attempt);
          await this.options.testHooks.beforeOpen(runId, attempt);
        }
        const endpoint = await desktop.prepare(agentId);
        proxy = { close: () => desktop.stopAgent(agentId) };
        signal.throwIfAborted();
        // Chrome is an application on this desktop, so the person watching may simply
        // have closed its window. Reopen it instead of failing the run; the desktop,
        // the profile and everything else the bot was doing are still there.
        const health = await fetch(endpoint.base + '/health', { headers: { Authorization: 'Bearer ' + endpoint.token }, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) })
          .then(response => response.ok ? response.json() as Promise<{ chrome?: string }> : undefined)
          .catch(() => undefined);
        if (health?.chrome === 'stopped') {
          const started = await fetch(endpoint.base + '/chrome/start', { method: 'POST', headers: { Authorization: 'Bearer ' + endpoint.token }, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
          if (!started.ok) throw new Error('Chrome is closed on this bot’s desktop and did not reopen. Open it from the desktop and retry.');
        }
        // The desktop being healthy no longer implies Chrome's debugging port is open -
        // that is the point of Chrome being an ordinary application - so wait for the
        // endpoint itself. Connecting into that gap returned "Unexpected status 503".
        const cdpDeadline = Date.now() + 45_000;
        for (;;) {
          signal.throwIfAborted();
          const probe = await fetch(endpoint.base + '/cdp/json/version/', { headers: { Authorization: 'Bearer ' + endpoint.token }, signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) }).catch(() => undefined);
          if (probe?.ok) break;
          if (Date.now() >= cdpDeadline) throw new Error('Chrome on this bot’s desktop did not open its debugging port. Open Chrome from the desktop and retry.');
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        signal.throwIfAborted();
        browser = await chromium.connectOverCDP(endpoint.base + '/cdp', { headers: { Authorization: 'Bearer ' + endpoint.token }, timeout: 30000 });
        desktopEndpoint = endpoint;
      } else if (remote) {
        // The container runs its own egress proxy; the launch options travel in a header (see browser-sandbox.ts).
        proxy = { close: async () => {} };
        browser = await chromium.connect(remote.wsEndpoint, { timeout: 30000, headers: { 'x-playwright-launch-options': JSON.stringify({ headless: true, proxy: { server: remote.proxy, bypass: '<-loopback>' }, args: BROWSER_ARGS }) } })
          .catch((error: unknown) => {
            this.options.sandbox?.markBroken(error instanceof Error ? error.message : String(error));
            throw new Error('The sandboxed browser did not answer. It is restarting; try again in a minute.');
          });
      } else {
        const local = await browserEgress(this.options.previewOrigins); proxy = local;
        browser = await chromium.launch({ headless: !headed, ...(fixtureExecutable?{executablePath:fixtureExecutable}:{}),proxy: { server: local.url, bypass: '<-loopback>' }, args: BROWSER_ARGS, timeout: 20000 });
      }
      signal.throwIfAborted();
      const saved = !desktop ? this.options.store.getDatabase().prepare('SELECT ciphertext FROM browser_sessions WHERE agent_id=?').get(agentId) as { ciphertext: string } | undefined : undefined;
      const storageState = saved ? JSON.parse(await this.options.secrets.unprotect(saved.ciphertext)) : undefined;
      const context = desktop ? browser.contexts()[0] : await browser.newContext({ storageState, serviceWorkers: humanLogin ? 'allow' : 'block', acceptDownloads: true, viewport: { width: 1100, height: 760 } });
      if (!context) throw new Error('The bot’s persistent Chrome profile was not available.');
      context.setDefaultTimeout(10000); context.setDefaultNavigationTimeout(20000);
      const writes = new Set<string>();
      // Human sign-in owns this session exclusively. Interception disables the
      // HTTP cache and service-worker bypass changes ordinary site behavior.
      // Keep normal Chrome networking during login; the public-only egress
      // proxy still applies. Model sessions retain their request approval gate.
      const probes = this.options.publishProbes ?? [];
      const seam = this.options.fixtureRoutes;
      if (!humanLogin) await context.route('**/*', async route => {
        const req = route.request(); const url = new URL(req.url());
        if (!['http:', 'https:'].includes(url.protocol) || (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && !writes.has(url.origin) && !writes.has('*') && !this.autonomyAllows(agentId, url.hostname))) { await route.abort('blockedbyclient'); return; }
        if (probes.length && req.method() !== 'GET' && probes.some(probe => probe.origins.includes(url.origin))) {
          let postData: string | null = null;
          try { postData = req.postData(); } catch { postData = null; }
          let failedAttempt: string | undefined;
          // PUBLISH_ATTEMPTED is written here, synchronously, before the request leaves Chrome (spec 6.2, 8.6).
          const emit = (type: string, payload: unknown) => {
            try { this.emitFor(agentId, runId, type, payload); }
            catch (error) { if (type === 'PUBLISH_ATTEMPTED') failedAttempt = (payload as PublishAttempted).publishId; throw error; }
          };
          const decision = publishRouteDecision({ watch: runRecord.watch, probes, req: { method: req.method(), url, postData }, emit });
          // The insert failed, so the request is aborted: drop its admitted record rather than leave a phantom pending post (decision A).
          if (failedAttempt) runRecord.watch.dropAdmitted(failedAttempt);
          if (decision.kind === 'abort') { await route.abort('blockedbyclient'); return; }
          if (decision.kind === 'track') {
            try { if (!(seam?.origin === url.origin && await seam.handle(route))) await route.continue(); }
            finally { void runRecord.watch.track(decision.record, req.response().catch(() => null)).catch(() => {}); }
            return;
          }
        }
        if (seam?.origin === url.origin && await seam.handle(route)) return;
        await route.continue();
      });
      if (!humanLogin) await context.routeWebSocket('**/*', ws => {
        const url=new URL(ws.url());
        // WhatsApp receipts require its connection. Preserve the existing interaction gate,
        // public-only proxy and default refusal for other, uninstrumented socket transports.
        if(url.origin==='wss://web.whatsapp.com'&&(writes.has('https://web.whatsapp.com')||this.autonomyAllows(agentId,'web.whatsapp.com')))ws.connectToServer();
        else ws.close();
      });
      const page = desktop ? context.pages()[0] ?? await context.newPage() : await context.newPage();
      if (desktop && !humanLogin) {
        // Persistent Chrome may already have service workers. Route page requests
        // through the same approval checks instead of a cached worker response.
        for (const existingPage of context.pages()) {
          const cdp = await context.newCDPSession(existingPage);
          await cdp.send('Network.setBypassServiceWorker', { bypass: true });
        }
      }
      context.on('page', p => {
        if (context.pages().length > 8) { void p.close(); return; }
        // Later pages need the bypass that pages open at start get (401-404), or a cached worker could answer a post outside the route (spec 6.3 item 4).
        // A page that closes before its CDP session attaches needs no bypass, so that failure is ignored.
        if (desktop && !humanLogin) void context.newCDPSession(p).then(cdp => cdp.send('Network.setBypassServiceWorker', { bypass: true })).catch(() => {});
      });
      const closeNow = () => { void this.endRun(runId).catch(error => this.stateErrors.set(agentId, String(error.message ?? error))); };
      // Deferred teardown (spec 6.10): after a timeout or cancel, keep the session up to 30 s while a post is
      // unresolved, so the close-out can still check the page. Shutdown, a disconnect and endRun end it at once.
      const onSignalAbort = () => {
        if (this.lifetime.signal.aborted || !runRecord.watch.unresolved().length || this.sessions.get(runId) !== session) { closeNow(); return; }
        clearTimeout(session.teardownTimer);
        session.teardownTimer = setTimeout(closeNow, 30_000);
        session.teardownTimer.unref();
      };
      signal.throwIfAborted();
      const session: Session = { browser, context, page, writes, agentId, runId, release, proxy, signal, abort: onSignalAbort, typed: new Map(), run: runRecord, isolation: desktop || remote ? 'sandbox' : 'computer', desktop: !!desktop };
      if (desktop && desktopEndpoint) {
        const endpoint = desktopEndpoint;
        const tracked = new Map<string, { suggestedFilename: string; state: string }>();
        const cdp = await browser.newBrowserCDPSession();
        // Downloads land in the container's own directory, which the gateway serves back.
        // This setting is browser-wide and cannot be scoped to the bot: allowAndName renamed
        // every file to its GUID, including ones the person downloaded themselves while
        // watching the desktop. 'allow' keeps Chrome's own naming for both.
        await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: '/home/bot/Downloads', eventsEnabled: true });
        cdp.on('Browser.downloadWillBegin' as never, (event: { guid: string; suggestedFilename: string }) =>
          tracked.set(event.guid, { suggestedFilename: event.suggestedFilename, state: 'inProgress' }));
        cdp.on('Browser.downloadProgress' as never, (event: { guid: string; state: string }) => {
          const entry = tracked.get(event.guid);
          if (entry) entry.state = event.state;
        });
        session.desktopDownloads = tracked;
        // Chrome now writes the real filename, so the file is fetched by name. The
        // gateway resolves the collision suffix Chrome adds when the name is taken.
        session.fetchDesktopDownload = async (name: string) => {
          const response = await fetch(`${endpoint.base}/downloads/${encodeURIComponent(name)}`, {
            headers: { Authorization: 'Bearer ' + endpoint.token },
            signal: AbortSignal.timeout(120_000),
          });
          if (!response.ok) throw new Error(`The bot desktop did not return the downloaded file (HTTP ${response.status}).`);
          return Buffer.from(await response.arrayBuffer());
        };
        session.readDesktopFile = async (desktopPath: string) => {
          const response = await fetch(`${endpoint.base}/files`, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + endpoint.token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ operation: 'read', path: desktopPath, encoding: 'base64' }),
            signal: AbortSignal.timeout(120_000),
          });
          const payload = await response.json().catch(() => undefined) as { content?: string; error?: string } | undefined;
          if (!response.ok || typeof payload?.content !== 'string') {
            throw new Error(payload?.error ?? `The file "${desktopPath}" could not be read from this bot's computer.`);
          }
          return Buffer.from(payload.content, 'base64');
        };
      }
      // Check before publishing the session; no await between this check and registering cancellation.
      this.sessions.set(runId, session); signal.addEventListener('abort', onSignalAbort, { once: true });
      this.armIdleCleanup(session);
      this.emit(session, 'BROWSER_OPENED', { isolation: session.isolation });
      browser.once('disconnected', closeNow);
      return session;
    } catch (error) {
      if (createdRun && this.runs.get(runId) === createdRun) this.runs.delete(runId);
      try {
        await browser?.close().catch(() => {});
        try { await proxy?.close(); }
        catch (cleanupError) { this.stateErrors.set(agentId, 'The browser could not stop its desktop. Check desktop status before retrying.'); throw cleanupError; }
      }
      finally { release(); }
      throw error;
    }
    finally { this.opening.delete(agentId); }
  }

  private emit(session: Session, type: string, payload: unknown) { this.emitFor(session.agentId, session.runId, type, payload); }
  /** Synchronous and durable: the route handler writes PUBLISH_ATTEMPTED through this before route.continue(). */
  private emitFor(agentId: string, runId: string, type: string, payload: unknown) {
    this.options.store.transaction(()=>{
      if(type==='PUBLISH_ATTEMPTED'||type==='PUBLISH_OBSERVED')new GoalResults(this.options.store).publicationEvent(agentId,runId,type,payload,(payload as {by?:string}).by==='flow'?this.runs.get(runId)?.expectedAccount:undefined);
      this.options.store.recordEvent({ task_run_id: runId, agent_id: agentId, event_type: type, timestamp: Date.now(), payload_json: JSON.stringify(payload) });
    });
  }

  private newRunRecord(runId: string, agentId: string | undefined, policy: RunPolicy | undefined, ephemeral: boolean): RunRecord {
    // setRunPolicy takes no agent id, so the owner is read from the run when an event is written.
    const emit = (type: string, payload: unknown) => this.emitFor(agentId ?? this.runOwner(runId), runId, type, payload);
    return { policy, ephemeral, trace:[], watch: new PublishWatch({ probes: this.options.publishProbes ?? [], policy, emit, resolvePostUrl: record => this.resolvePostUrl(runId, record) }) };
  }
  /** postUrl for a confirmed record (spec 6.3): the account link on the current page, never a navigation. Stage 2 reads run.expectedAccount here for by:'flow' records. */
  private async resolvePostUrl(runId: string, record: PublishRecord): Promise<string | undefined> {
    if (!record.postId) return undefined;
    const probe = this.options.publishProbes?.find(p => p.id === record.probe);
    const page = this.sessions.get(runId)?.page;
    const handle = record.by==='flow'?this.runs.get(runId)?.expectedAccount:(probe && page && !page.isClosed() ? await this.accountOn(page, probe) : null);
    return probe && handle ? record.origin + probe.postPath(handle, record.postId) : record.origin + '/i/status/' + record.postId;
  }
  /** The signed-in handle from the probe's account link (X: link "Profile", href /<handle>), or null. One bounded read. */
  async readOwnRecentPosts(input:{agentId:string;runId:string;limit:number;signal:AbortSignal}) {
    if(!Number.isInteger(input.limit)||input.limit<1||input.limit>40)throw new Error('Post import limit must be 1–40.');
    const signal=AbortSignal.any([input.signal,AbortSignal.timeout(20000)]);
    return this.withLease(input.agentId,input.runId,signal,async s=>{
      const probe=this.options.publishProbes?.find(p=>p.id==='x-create-tweet')??this.options.publishProbes?.find(p=>p.origins.includes('https://x.com'));
      if(!probe)throw new Error('Own-account reader is unavailable. Paste samples instead.');
      const start=s.page.url();
      try{
        if(!probe.origins.some(o=>start.startsWith(o))){await s.page.goto(probe.origins[0]+'/home',{waitUntil:'domcontentloaded',timeout:15000});}
        const handle=await this.accountOn(s.page,probe);
        if(!handle)throw new Error('Sign in to the bot’s account before importing its posts.');
        const origin=probe.origins.find(o=>start.startsWith(o))??probe.origins[0];
        const profile=probe.profilePaths(handle,'post')[0];
        if(!profile)throw new Error('Own profile is unavailable.');
        await raceAbort(s.page.goto(origin+profile,{waitUntil:'domcontentloaded'}),signal);
        this.requireFreshObservation(input.agentId,input.runId,'Own-profile reader navigated.');
        if((await this.accountOn(s.page,probe))?.toLowerCase()!==handle.toLowerCase())throw new Error('Signed-in account changed.');
        while(!await this.profileReady(s.page)){signal.throwIfAborted();await pause(200,signal);}
        const articles=await s.page.evaluate(limit=>[...document.querySelectorAll('article')].slice(0,limit).map(a=>({
          links:[...a.querySelectorAll('a[href]')].slice(0,30).map(v=>(v as HTMLAnchorElement).href),
          text:(a.querySelector('[data-testid="tweetText"]') as HTMLElement|null)?.innerText??'',
          postedAt:a.querySelector('time')?.getAttribute('datetime')??null,
          metrics:Object.fromEntries(['reply','retweet','like'].map(k=>[k,a.querySelector(`[data-testid="${k}"]`)?.getAttribute('aria-label')??null]))
        })),input.limit);
        signal.throwIfAborted();
        const own=new RegExp('^/'+handle.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/status/(\\d+)$','i');
        return articles.flatMap(a=>{const url=a.links.find(l=>{try{const u=new URL(l);return u.origin===origin&&own.test(u.pathname);}catch{return false;}});if(!url||!a.text)return [];
          return [{postId:own.exec(new URL(url).pathname)![1],url,text:a.text.slice(0,4000),postedAt:a.postedAt,accountHandle:handle,metrics:a.metrics}];});
      }finally{
        if(!signal.aborted&&!s.page.isClosed()&&s.page.url()!==start){await raceAbort(s.page.goto(start,{waitUntil:'domcontentloaded'}),signal);this.requireFreshObservation(input.agentId,input.runId,'Own-profile reader returned; observe the page again.');}
      }
    });
  }
  private async accountOn(page: Page, probe: PublishProbe): Promise<string | null> {
    try {
      const link = page.getByRole(probe.account.role, { name: probe.account.name, exact: true });
      if (await link.count() !== 1) return null;
      const href = await link.first().getAttribute('href', { timeout: 2000 });
      if (!href) return null;
      return /^\/([A-Za-z0-9_]{1,50})\/?$/.exec(new URL(href, page.url()).pathname)?.[1] ?? null;
    } catch { return null; }
  }
  private runOwner(runId: string): string {
    const owner = this.options.store.getTaskRun(runId)?.agent_id;
    if (!owner) throw new Error('A publish event must belong to a recorded run.');
    return owner;
  }

  private armIdleCleanup(s: Session) {
    // Human control has its own timer; touching the model session must not cancel it.
    if (s.controlled || s.loginSite) return;
    clearTimeout(s.idle);
    if (s.signal.aborted || this.sessions.get(s.runId) !== s || this.closing.has(s.runId)) return;
    s.idle = setTimeout(() => {
      if (s.controlled || s.loginSite || this.sessions.get(s.runId) !== s || this.closing.has(s.runId)) return;
      // Provider reasoning and an in-flight transfer are not abandoned sessions.
      // The run's own deadline, abort signal and shutdown still stop them.
      if (s.actionDone || this.options.store.getTaskRun(s.runId)?.status === 'RUNNING') {
        this.armIdleCleanup(s);
        return;
      }
      void this.endRun(s.runId).catch(error => this.stateErrors.set(s.agentId, String(error.message ?? error)));
    }, this.options.idleTimeoutMs ?? 180000);
    s.idle.unref();
  }

  async call(agentId: string, runId: string, action: BrowserAction, signal: AbortSignal) {
    return this.withLease(agentId, runId, signal, s => this.performCall(s, action, signal));
  }

  /** Narrow text-send path. Uses the existing bot lease and permission system; never guesses self identity. */
  async sendWhatsApp(agentId:string,runId:string,input:{resultId:string;recipient:string;text:string;attachment?:{artifactId:string;sourceRunId:string}},signal:AbortSignal){
    const chat=whatsappTarget(input.recipient),results=new GoalResults(this.options.store);
    const requirement=results.manifest(agentId,runId)?.requirements.find(r=>r.id===input.resultId);
    if(!requirement||requirement.kind!=='message'||requirement.target!==input.recipient||requirement.acceptance.verifier!=='whatsapp/1')throw new Error('Declare the exact message result and recipient before sending.');
    if(requirement.acceptance.receipt==='read')throw new Error('Read receipts cannot be independently verified by this adapter. Ask the owner to choose supported sent or delivered evidence before sending.');
    const file=input.attachment&&this.options.store.getTaskRun(input.attachment.sourceRunId)?.agent_id===agentId?this.options.artifacts.read(input.attachment.sourceRunId,input.attachment.artifactId):null;
    if(input.attachment&&(!file||file.encoding==='base64'))throw new Error('This document-send adapter requires a retained text report owned by this bot.');
    if((requirement.acceptance.attachmentPaths?.length??0)!==(file?1:0)||file&&requirement.acceptance.attachmentPaths?.[0]!==file.path)throw new Error('The attachment must match the declared file path.');
    const attachment=file?{path:file.path,digest:contentDigest(file.content)}:undefined;
    return this.withLease(agentId,runId,signal,async s=>{
      if(s.needsObservation)throw new Error('Observe the current browser state before sending.');
      const before=await whatsappSnapshot(s.page);
      if(before.origin!=='https://web.whatsapp.com'||before.chat!==chat||before.composerCount!==1)throw new Error('The selected WhatsApp chat identity or composer could not be verified. Select and inspect the intended chat.');
      if(before.composerText?.trim())throw new Error('The composer already contains text. Inspect it before replacing anything.');
      if(!s.writes.has(before.origin)){
        if(!this.autonomyAllows(agentId,'web.whatsapp.com')){
          if(!this.options.approvals)throw new Error('Browser interaction permission unavailable.');
          const decision=await this.options.approvals.request({taskRunId:runId,agentId,kind:'browser-interaction',payload:{origin:before.origin,action:'send-message',scope:'Send the requested text to the declared WhatsApp recipient.'},timeoutMs:60000,abortSignal:signal});
          if(decision.status!=='APPROVED')throw new Error('Browser interaction was not approved.');
        }
        s.writes.add(before.origin);
      }
      const exactDigest=contentDigest(input.text),attempt=results.start(agentId,runId,input.resultId,input.recipient,exactDigest,`whatsapp:${runId}:${input.resultId}:${randomUUID()}`);
      results.saveAttemptContext(attempt,{chat,beforeIds:before.messages.map(m=>m.id),attachment});
      let dispatched=false;
      try{
        let composer=s.page.locator('#main footer [contenteditable="true"][role="textbox"]');
        let send:Locator|undefined;
        if(file){
          // Open the document attachment chooser using an observed browser control first.
          // No guessed selector may choose among multiple inputs or preview controls.
          const picker=s.page.locator('input[type="file"][accept="*"], input[type="file"][accept="*/*"]');
          if(await picker.count()!==1)throw new Error('Open the WhatsApp document attachment menu first; a unique document input is required.');
          await picker.setInputFiles({name:path.basename(file.path),mimeType:/\.html?$/i.test(file.path)?'text/html':'text/plain',buffer:Buffer.from(file.content,'utf8')},{timeout:5000});
          composer=s.page.locator('[contenteditable="true"][role="textbox"]').filter({visible:true});
          send=s.page.locator('[data-icon="send"]').filter({visible:true});
          if(await composer.count()!==1||await send.count()!==1)throw new Error('The document preview caption or send control is ambiguous. Nothing was submitted.');
        }
        await composer.fill(input.text,{timeout:5000});
        const ready=await whatsappSnapshot(s.page);signal.throwIfAborted();
        if(ready.origin!==before.origin||ready.chat!==chat||contentDigest(await composer.innerText())!==exactDigest)throw new Error('Recipient or exact message changed before submission.');
        if(file){const selected=await s.page.locator('input[type="file"][accept="*"], input[type="file"][accept="*/*"]').evaluate(async element=>{const files=(element as HTMLInputElement).files;if(files?.length!==1)return null;const bytes=await files[0]!.arrayBuffer();return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');});if(selected!==attachment!.digest)throw new Error('The selected attachment bytes changed before submission.');}
        results.dispatched(attempt);dispatched=true;
        this.emit(s,'EXTERNAL_ACTION_STARTED',{actionId:attempt,transport:'browser',origin:before.origin,action:'send-message'});
        if(send)await send.click({timeout:5000});else await composer.press('Enter',{timeout:5000});
        const until=Date.now()+15000;
        do{
          signal.throwIfAborted();const receipt=matchWhatsAppReceipt({beforeIds:before.messages.map(m=>m.id),snapshot:await whatsappSnapshot(s.page),chat,exactDigest,attachment:!!file});
          const sufficient=receipt&&(requirement.acceptance.receipt==='sent'||requirement.acceptance.receipt==='delivered'&&receipt.receipt==='delivered');
          if(sufficient){
            if(attachment)await this.checkWhatsAppAttachment(s,receipt.id,attachment.digest,signal);
            results.receipt(attempt,{verifier:'whatsapp/1',target:input.recipient,digest:exactDigest,receipt:receipt.receipt as 'sent'|'delivered',reference:receipt.id,observedAt:Date.now(),account:null,...(attachment?{attachmentDigests:[attachment.digest]}:{})});
            this.emit(s,'EXTERNAL_ACTION_FINISHED',{actionId:attempt,transport:'browser',origin:before.origin,status:'ok'});
            this.requireFreshObservation(agentId,runId,'A message was submitted. Observe before continuing.');
            return {state:receipt.receipt,resultId:input.resultId,accountKnown:false};
          }
          await delay(250,undefined,{signal});
        }while(Date.now()<until);
        throw new Error('Message receipt not observed.');
      }catch(error){
        if(dispatched){results.uncertain(attempt);this.requireFreshObservation(agentId,runId,'Message outcome is uncertain. Do not submit it again.');throw new Error('Message outcome is uncertain. Inspect the intended chat; do not repeat the submission.');}
        results.failedBeforeDispatch(attempt);throw error;
      }
    },{reuseOnly:true,waitForLease:true});
  }

  /** Reads a previously submitted attempt, including after a daemon restart. Never sends or navigates. */
  async reconcileWhatsApp(agentId:string,runId:string,attemptId:string,signal:AbortSignal){
    const results=new GoalResults(this.options.store),attempt=results.unresolved(agentId).find(a=>a.id===attemptId);
    if(!attempt||!attempt.context_json||!['dispatched','uncertain'].includes(attempt.state))throw new Error('No unresolved WhatsApp attempt for this bot.');
    const context=JSON.parse(attempt.context_json) as {chat:string;beforeIds:string[];attachment?:{path:string;digest:string}};
    return this.withLease(agentId,runId,signal,async s=>{
      const receipt=matchWhatsAppReceipt({beforeIds:context.beforeIds,snapshot:await whatsappSnapshot(s.page),chat:context.chat,exactDigest:attempt.digest,attachment:!!context.attachment});
      if(!receipt)return {state:'uncertain',attemptId};
      try{if(context.attachment)await this.checkWhatsAppAttachment(s,receipt.id,context.attachment.digest,signal);results.receipt(attempt.id,{verifier:'whatsapp/1',target:attempt.target,digest:attempt.digest,receipt:receipt.receipt as 'sent'|'delivered',reference:receipt.id,observedAt:Date.now(),account:null,...(context.attachment?{attachmentDigests:[context.attachment.digest]}:{})});}
      catch{return {state:'uncertain',attemptId,reason:'Observed receipt does not satisfy the declared acceptance level.'};}
      return {state:receipt.receipt,attemptId};
    },{reuseOnly:true,waitForLease:true});
  }

  /** Downloads only the document on the exact outgoing receipt; filename is never identity evidence. */
  private async checkWhatsAppAttachment(s:Session,messageId:string,digest:string,signal:AbortSignal){
    if(!/^(true)_([0-9]+@c\.us)_([A-Za-z0-9_-]+)$/.test(messageId))throw new Error('Unrecognized message identity.');
    const target=s.page.locator(`[data-id="${messageId}"] [data-icon="download"], [data-id="${messageId}"] [data-icon="document"]`).filter({visible:true});
    if(await target.count()!==1)throw new Error('A unique outgoing attachment download control is required to verify its bytes.');
    signal.throwIfAborted();const prior=new Set(s.desktopDownloads?.keys()??[]);
    const [download]=await Promise.all([s.page.waitForEvent('download',{timeout:10000}),target.click({timeout:5000})]);
    let bytes:Buffer;
    if(s.desktopDownloads&&s.fetchDesktopDownload){
      const until=Date.now()+20000;let ready=false;
      do{signal.throwIfAborted();const candidates=[...s.desktopDownloads].filter(([id,d])=>!prior.has(id)&&d.suggestedFilename===download.suggestedFilename());if(candidates.length>1)throw new Error('Ambiguous attachment download.');if(candidates[0]?.[1].state==='completed'){ready=true;break;}await delay(100,undefined,{signal});}while(Date.now()<until);
      if(!ready)throw new Error('Attachment download did not finish.');bytes=await s.fetchDesktopDownload(download.suggestedFilename());
    }else{
      const stream=await download.createReadStream(),chunks:Buffer[]=[];let size=0;
      for await(const chunk of stream){signal.throwIfAborted();size+=chunk.length;if(size>MAX_BROWSER_DOWNLOAD_BYTES){await download.cancel();throw new Error('Attachment exceeds verification limit.');}chunks.push(Buffer.from(chunk));}bytes=Buffer.concat(chunks);
    }
    if(bytes.length>MAX_BROWSER_DOWNLOAD_BYTES||contentDigest(bytes)!==digest)throw new Error('Outgoing attachment bytes do not match the retained report.');
  }

  /**
   * The one-action lease shared by call(), confirmPublish() and closeOutPublishes() (spec 6.3 item 2).
   * The checks and their texts are call()'s, in the same order. waitForLease waits for an in-flight
   * action instead of refusing; reuseOnly never opens a session and rejects with NoSession instead.
   */
  private async withLease<T>(agentId: string, runId: string, signal: AbortSignal, fn: (s: Session) => Promise<T>, opts: { waitForLease?: boolean; reuseOnly?: boolean } = {}): Promise<T> {
    const run = this.options.store.getTaskRun(runId);
    if (run?.agent_id !== agentId || run.status !== 'RUNNING') throw new Error('Browser calls must belong to this bot and its running task.');
    if (this.options.enabled === false) throw new Error('Browser tools are disabled.');
    let s: Session;
    if (opts.reuseOnly) {
      const live = this.sessions.get(runId);
      if (!live || live.agentId !== agentId || this.closing.has(runId)) throw new NoSession();
      s = live;
    } else s = await this.open(agentId, runId, signal);
    signal.throwIfAborted();
    for (;;) {
      while (s.controlled) {
        await new Promise<void>((resolve, reject) => {
          const abort = () => { s.resume = undefined; reject(signal.reason); };
          s.resume = () => { signal.removeEventListener('abort', abort); resolve(); };
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); }
        });
      }
      if (s.controlEnded) throw s.controlEnded;
      if (!s.actionDone) break;
      if (!opts.waitForLease) throw new Error('An interaction is already running. Observe after it finishes.');
      // A takeover can start while this waits, so control is checked again after every wait.
      await settledOrAborted(s.actionDone, signal);
    }
    let releaseAction!: () => void;
    s.actionDone = new Promise<void>(resolve => { releaseAction = resolve; });
    try { return await fn(s); }
    finally { s.actionDone = undefined; releaseAction(); }
  }

  /** Creates the run's record before it opens a browser; the record outlives the session (spec 8.5). */
  setRunPolicy(runId: string, policy: RunPolicy): void {
    if (this.sessions.has(runId) || this.closing.has(runId)) throw new Error('A run policy must be set before the run opens its browser.');
    this.runs.set(runId, this.newRunRecord(runId, undefined, policy, false));
  }
  /** WorkRuntime's finally calls this after endRun. */
  clearRunPolicy(runId: string): void {
    this.runs.delete(runId);
    this.openAttempts.delete(runId);
  }
  publishes(runId: string): readonly PublishRecord[] {
    return this.runs.get(runId)?.watch.all() ?? [];
  }

  async computerCall(agentId: string, runId: string, input: ComputerAction, signal: AbortSignal): Promise<{ width: number; height: number; image: ChatImage }> {
    const action = computerAction.parse(input);
    if (['click', 'double_click', 'right_click', 'move', 'drag'].includes(action.action) && (action.x === undefined || action.y === undefined)) throw new Error('Supply x and y from the latest desktop screenshot.');
    if (action.action === 'drag' && (action.toX === undefined || action.toY === undefined)) throw new Error('Supply drag destination toX and toY.');
    if (action.action === 'type' && (action.text === undefined || action.text.includes('\0'))) throw new Error('Supply text without null characters.');
    if (action.action === 'key' && !action.key) throw new Error('Supply a key combination.');
    if (action.action === 'scroll' && !action.direction) throw new Error('Supply a scroll direction.');
    if (this.options.enabled === false || !this.options.desktop) throw new Error('This installation has no enabled bot desktop. The personal computer will not be used.');
    const run = this.options.store.getTaskRun(runId);
    if (run?.agent_id !== agentId || run.status !== 'RUNNING') throw new Error('Computer action requires a running task belonging to this bot.');
    const s = await this.open(agentId, runId, signal);
    await this.waitForOperator(runId, signal);
    const screenshot = action.action === 'screenshot';
    if (!screenshot && (s.needsObservation || !s.computerScreen || Date.now() - s.computerScreen.observedAt > 60000)) throw new Error('Take a fresh computer screenshot before using native input.');
    if (!screenshot && s.computerScreen) {
      for (const [x, y] of [[action.x, action.y], [action.toX, action.toY]]) if (x !== undefined && (y === undefined || x >= s.computerScreen.width || y >= s.computerScreen.height)) throw new Error('Coordinates are outside the observed desktop. Take a new screenshot.');
    }
    const endpoint = this.options.desktop.endpoint(agentId);
    if (!endpoint) throw new Error('The bot desktop is unavailable. Retry its setup.');
    // Browser calls and operator takeover share this same exclusive action lease.
    if (s.actionDone) throw new Error('An interaction is already running. Observe after it finishes.');
    let release!: () => void;
    s.actionDone = new Promise<void>(resolve => { release = resolve; });
    let actionId: string | undefined;
    try {
      const scope = `bot-desktop:${agentId}`;
      if (!screenshot && !s.writes.has(scope)) {
        if (browserAutonomy(this.options.store, agentId) !== 'always') {
          if (!this.options.approvals) throw new Error('Native desktop interaction needs an approval gate.');
          const grant = await this.options.approvals.request({ taskRunId: runId, agentId, kind: 'browser-interaction', payload: {
            origin: scope, scope: 'Control this bot’s isolated Linux desktop for this run, including its apps and browser. This does not grant access to the personal computer.', action: action.action,
          }, timeoutMs: 60000, abortSignal: signal });
          if (grant.status !== 'APPROVED') throw new Error('Desktop interaction was not approved.');
        }
        s.writes.add(scope);
      }
      signal.throwIfAborted();
      if (!screenshot) {
        actionId = randomUUID();
        this.emit(s, 'EXTERNAL_ACTION_STARTED', { actionId, transport: 'computer', action: action.action });
      }
      const response = await fetch(endpoint.base + '/computer', { method: 'POST', headers: { Authorization: 'Bearer ' + endpoint.token, 'Content-Type': 'application/json' }, body: JSON.stringify(action), signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
      if (response.status === 400 || response.status === 409) {
        if (actionId) this.emit(s, 'EXTERNAL_ACTION_FINISHED', { actionId, transport: 'computer', outcome: 'not_dispatched' });
        actionId = undefined;
        throw new Error('Desktop input was not dispatched: it is busy or the target is invalid. Take a fresh screenshot before continuing.');
      }
      if (!response.ok) throw new Error('The bot desktop did not complete the operation.');
      const result = await response.json() as { width: number; height: number; image: ChatImage };
      if (!Number.isInteger(result.width) || !Number.isInteger(result.height) || result.image?.mime !== 'image/png' || typeof result.image.data !== 'string' || result.image.data.length > 12 * 1024 * 1024) throw new Error('Invalid desktop observation.');
      signal.throwIfAborted();
      s.computerScreen = { width: result.width, height: result.height, observedAt: Date.now() };
      s.needsObservation = false;
      s.refs = undefined; // Native input may have navigated or changed the browser.
      if (actionId) this.emit(s, 'EXTERNAL_ACTION_FINISHED', { actionId, transport: 'computer' });
      this.emit(s, 'COMPUTER_STATE', { action: action.action, width: result.width, height: result.height, timestamp: Date.now() });
      return result;
    } catch (error) {
      s.computerScreen = undefined;
      if (actionId) throw new Error('Computer interaction outcome is uncertain. Inspect the desktop and action history; do not repeat the submission automatically.');
      throw error;
    } finally { s.actionDone = undefined; release(); }
  }

  /**
   * The bot's own computer: a shell, its files and its applications, all inside the
   * bot's container. This never reaches the operator's machine - there is no host
   * filesystem in that container, the process runs as the unprivileged `bot` user
   * under the image's seccomp profile, and its network still leaves through the proxy.
   */
  async desktopCall(agentId: string, runId: string, kind: 'exec' | 'files' | 'apps' | 'record' | 'jobs' | 'display', input: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.options.enabled === false || !this.options.desktop) throw new Error('This installation has no enabled bot desktop. The personal computer will not be used.');
    const run = this.options.store.getTaskRun(runId);
    if (run?.agent_id !== agentId || run.status !== 'RUNNING') throw new Error('Desktop actions require a running task belonging to this bot.');
    const s = await this.open(agentId, runId, signal);
    await this.waitForOperator(runId, signal);
    const endpoint = this.options.desktop.endpoint(agentId);
    if (!endpoint) throw new Error('The bot desktop is unavailable. Retry its setup.');
    if (s.actionDone) throw new Error('An interaction is already running. Observe after it finishes.');
    let release!: () => void;
    s.actionDone = new Promise<void>(resolve => { release = resolve; });
    // Listing a directory or reading a file changes nothing, so it does not need the
    // approval that running a command or opening an application does.
    const operation = (input as { operation?: unknown } | null)?.operation;
    const observes = (kind === 'files' && (operation === 'list' || operation === 'read'))
      || (kind === 'record' && operation === 'status')
      || (kind === 'jobs' && (operation === 'list' || operation === 'output'))
      || (kind === 'display' && operation === 'get');
    let actionId: string | undefined;
    try {
      const scope = `bot-desktop:${agentId}`;
      if (!observes && !s.writes.has(scope)) {
        if (browserAutonomy(this.options.store, agentId) !== 'always') {
          if (!this.options.approvals) throw new Error('Desktop control needs an approval gate.');
          const grant = await this.options.approvals.request({ taskRunId: runId, agentId, kind: 'browser-interaction', payload: {
            origin: scope, scope: 'Run commands, change files and open applications on this bot’s own Linux computer. This does not grant access to the personal computer.', action: kind,
          }, timeoutMs: 60000, abortSignal: signal });
          if (grant.status !== 'APPROVED') throw new Error('Desktop control was not approved.');
        }
        s.writes.add(scope);
      }
      signal.throwIfAborted();
      if (!observes) {
        actionId = randomUUID();
        this.emit(s, 'EXTERNAL_ACTION_STARTED', { actionId, transport: 'computer', action: kind });
        // A command or an app launch can move windows and repaint the screen, so any
        // coordinates the model observed earlier are no longer trustworthy.
        s.computerScreen = undefined;
      }
      const response = await fetch(endpoint.base + '/' + kind, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + endpoint.token, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        // Longer than a screenshot: a command is allowed up to five minutes of its own.
        signal: AbortSignal.any([signal, AbortSignal.timeout(320_000)]),
      });
      const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
      if (response.status === 400 || response.status === 409) {
        if (actionId) this.emit(s, 'EXTERNAL_ACTION_FINISHED', { actionId, transport: 'computer', outcome: 'not_dispatched' });
        actionId = undefined;
        // Rejected before anything ran, so the real reason is safe and useful to return.
        throw new Error(payload?.error ?? 'The bot desktop refused the request.');
      }
      if (!response.ok) throw new Error('The bot desktop did not complete the operation.');
      signal.throwIfAborted();
      if (actionId) this.emit(s, 'EXTERNAL_ACTION_FINISHED', { actionId, transport: 'computer' });
      actionId = undefined;
      return payload;
    } catch (error) {
      if (actionId) throw new Error(`The ${kind} request started but its outcome is uncertain. Inspect the desktop and the action history; do not repeat it automatically.`);
      throw error;
    } finally { s.actionDone = undefined; release(); }
  }

  /**
   * The operator did something on this bot's desktop, so nothing the model observed
   * earlier can be trusted. Every later action must look again first: a person asked to
   * enter a code may also have dismissed a dialog, navigated, or completed the very
   * submission the model was about to repeat.
   */
  markOperatorActed(agentId: string, runId: string) {
    this.requireFreshObservation(agentId, runId, OPERATOR_ACTED);
  }

  /** Refuses the next non-observing browser action with this reason until a snapshot, tabs or screenshot (spec 6.3 item 7). */
  requireFreshObservation(agentId: string, runId: string, reason: string) {
    const s = this.sessions.get(runId);
    if (!s || s.agentId !== agentId) return;
    s.needsObservation = true;
    s.observationReason = reason;
    s.computerScreen = undefined;
    s.refs = undefined;
  }

  trace(runId:string):readonly RecordedStep[] {const r=this.runs.get(runId);return structuredClone(r?.traceOverflow?[...(r.trace??[]),{kind:'other',action:'trace-overflow',at:Date.now()} as RecordedStep]:r?.trace??[]);}
  private appendTrace(s:Session,step:RecordedStep){if(s.run.trace.length>=100)s.run.traceOverflow=true;else s.run.trace.push(step);}
  private flowLocator(page:Page,t:FlowTarget):Locator {
    const scope=t.scope?page.getByRole(t.scope.role as any,{...(t.scope.name!==undefined?{name:t.scope.name,exact:true}:{})}):page;
    return scope.getByRole(t.role as any,{name:t.name,exact:true});
  }
  private async uniqueFlowTarget(page:Page,t:FlowTarget) {
    if(t.scope&&await page.getByRole(t.scope.role as any,{...(t.scope.name!==undefined?{name:t.scope.name,exact:true}:{})}).count()!==1)throw new FlowMiss('not-unique','The learned landmark is not unique.');
    const locator=this.flowLocator(page,t);if(await locator.count()!==1)throw new FlowMiss('not-unique','The learned control is not unique.');return locator;
  }
  private async linkContext(page:Page,href:string) {
    return page.locator('a[href]').evaluateAll((links,wanted)=>{
      const a=links.find(e=>(e as HTMLAnchorElement).href===wanted);const box=a?.closest('article,[role="article"],li,[role="listitem"]');
      if(!box)return undefined;const role=box.tagName==='ARTICLE'||box.getAttribute('role')==='article'?'article':'listitem';
      const selector=role==='article'?'article,[role="article"]':'li,[role="listitem"]';
      return {container:role,siblings:[...document.querySelectorAll(selector)].flatMap(el=>[...el.querySelectorAll('a[href]')].map(a=>(a as HTMLAnchorElement).href)).slice(0,30)};
    },href).catch(()=>undefined);
  }
  private async recordedIdentity(s:Session,locator:Locator,action:BrowserAction):Promise<ElementIdentity|null> {
    let role=action.target?.role as string|undefined,name=action.target?.name;
    if(action.target?.ref){
      const line=s.lastState?.snapshot?.split('\n').find(line=>line.includes(`[ref=${action.target!.ref}]`));
      const match=line?.match(/^\s*-\s+([a-z]+)(?:\s+"((?:\\.|[^"\\])*)")?/i);role=match?.[1];
      try{name=match?.[2]===undefined?'':JSON.parse('"'+match[2]+'"');}catch{return null;}
    }
    if(!role||name===undefined||role==='file')return null;
    const dom=await locator.evaluate(el=>{
      const landmark=el.parentElement?.closest('main,dialog,form,header,nav,aside,footer,[role="main"],[role="dialog"],[role="alertdialog"],[role="form"],[role="banner"],[role="navigation"],[role="complementary"],[role="contentinfo"]');
      const native:Record<string,string>={MAIN:'main',DIALOG:'dialog',FORM:'form',HEADER:'banner',NAV:'navigation',ASIDE:'complementary',FOOTER:'contentinfo'};
      const label=landmark?.getAttribute('aria-label')??(landmark?.getAttribute('aria-labelledby')??'').split(/\s+/).map(id=>el.ownerDocument.getElementById(id)?.textContent??'').join(' ').trim();
      return {scope:landmark?{role:landmark.getAttribute('role')??native[landmark.tagName],...(label?{name:label}:{})}:null,
        topFrame:el.ownerDocument.defaultView===el.ownerDocument.defaultView?.top,
        anchor:!!(el instanceof HTMLAnchorElement&&el.href),editable:el instanceof HTMLInputElement?'input':el instanceof HTMLTextAreaElement?'textarea':(el as HTMLElement).isContentEditable?'contenteditable':null};
    });
    const t={role,name,scope:dom.scope??null} as FlowTarget;
    const scopeCount=t.scope?await s.page.getByRole(t.scope.role as any,{...(t.scope.name!==undefined?{name:t.scope.name,exact:true}:{})}).count():1;
    return {...t,scopeCount,countInScope:await this.flowLocator(s.page,t).count(),topFrame:dom.topFrame,anchor:dom.anchor,editable:dom.editable as ElementIdentity['editable']};
  }
  private async guardFlowCommit(s:Session,c:Extract<PlayStep,{kind:'commit'}>,signal:AbortSignal) {
    const probe=this.options.publishProbes?.find(p=>p.id===c.probe),url=new URL(s.page.url());
    if(!probe||!probe.origins.includes(url.origin)||!new RegExp(c.page).test(url.pathname))throw new FlowMiss('wrong-page','The composer page changed.');
    const account=await this.accountOn(s.page,probe);
    if(!account||account.toLowerCase()!==c.account.toLowerCase())throw new FlowAccountChanged(account);
    const recent=s.run.policy?.recent;
    if(recent?.textHashes.has(textSha256(c.expectText))||recent?.targets.has(statusIdOf(url.pathname)??''))throw new FlowMiss('duplicate','Already posted this text or replied to this target.');
    if((statusIdOf(url.pathname)??undefined)!==c.inReplyTo&&c.inReplyTo)throw new FlowMiss('target','The selected reply target changed.');
    const target=await this.uniqueFlowTarget(s.page,c.target);
    if(await target.evaluate(el=>!!(el instanceof HTMLAnchorElement&&el.href)))throw new FlowMiss('anchor','A submit control became a link.');
    const until=Date.now()+5000;while(!await target.isEnabled()){if(Date.now()>=until)throw new FlowMiss('disabled','The submit control is disabled.');await pause(100,signal);}
    const composer=await this.uniqueFlowTarget(s.page,c.readBack),text=await composer.evaluate(el=>el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement?el.value:(el as HTMLElement).innerText);
    if(normalizeEcho(text)!==normalizeEcho(c.expectText))throw new FlowMiss('text-mismatch','The composer does not contain the expected text.');
    const scope=c.target.scope?s.page.getByRole(c.target.scope.role as any,{...(c.target.scope.name!==undefined?{name:c.target.scope.name,exact:true}:{})}):s.page;
    const boxes=scope.getByRole('listbox');for(let i=0;i<await boxes.count();i++)if(await boxes.nth(i).isVisible())throw new FlowMiss('listbox','Dismiss the open completion list before submitting.');
    if(s.needsObservation)throw new FlowMiss('operator','The owner changed the page.');
    signal.throwIfAborted();
  }
  private async performCall(s: Session, action: BrowserAction, signal: AbortSignal,flow?:FlowOptions) {
    const { agentId, runId } = s;
    const fromUrl=s.page.url(),traceAt=Date.now();let traceTarget:ElementIdentity|null=null,traceLink:{container:string;siblings:string[]}|undefined,traceHref:string|undefined,traceAccount:string|null=null;
    if(flow&&s.needsObservation)throw new FlowMiss('operator','The owner changed the page.');
    s.computerScreen = undefined; // Browser actions invalidate native coordinate observations.
    if (s.needsObservation && !['snapshot', 'tabs', 'screenshot'].includes(action.action)) throw new Error(s.observationReason ?? OPERATOR_ACTED);
    this.emit(s, 'BROWSER_ACTION_START', {
      action: action.action,
      url: action.url ?? s.page.url(),
      target: action.target?.name,
      timestamp: Date.now(),
    });
    const locate = (choice = action.target) => {
      if(flow)return this.flowLocator(s.page,flow.target);
      if (!choice) throw new Error('Choose a target ref or role and accessible name from a fresh snapshot.');
      if (choice.ref) {
        if (!s.refs?.has(choice.ref)) throw new Error('Target reference is not in the latest observation. Take a fresh snapshot.');
        return s.page.locator(`aria-ref=${choice.ref}`);
      }
      const frame = s.page.frames()[choice.frame ?? 0];
      if (!frame) throw new Error('Frame no longer exists. Take a fresh snapshot.');
      if (!choice.role || choice.name === undefined) throw new Error('Supply ref, or role and name from the snapshot.');
      return (choice.role === 'file' ? (choice.name ? frame.getByLabel(choice.name, { exact: true }) : frame.locator('input[type="file"]')) : frame.getByRole(choice.role, { name: choice.name, exact: true })).nth(choice.index);
    };
    const navigate = async (value?: string) => { if (!value) throw new Error('Supply a URL.'); const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an http(s) URL without credentials.'); await s.page.goto(url.href, { waitUntil: 'domcontentloaded' }); };
    let artifact;
    let dispatchedActionId: string | undefined;
    // The rescue clears dispatchedActionId, so the publish field keeps its own copy (spec 6.3 item 5).
    let publishActionId: string | undefined;
    let publishOrigin: string | undefined;
    if (action.action === 'navigate') {traceLink=await this.linkContext(s.page,action.url!);traceHref=action.url;await navigate(action.url);}
    else if (action.action === 'new_tab') { if (s.context.pages().length >= 8) throw new Error('Tab limit reached.'); s.page = await s.context.newPage(); if (action.url) await navigate(action.url); }
    else if (action.action === 'use_tab') { const page = s.context.pages()[action.tab ?? -1]; if (!page) throw new Error('Unknown tab.'); s.page = page; }
    else if (action.action === 'close_tab') { const page = s.context.pages()[action.tab ?? -1]; if (!page) throw new Error('Unknown tab.'); await page.close(); s.page = s.context.pages()[0] ?? await s.context.newPage(); }
    else if (action.action === 'screenshot') artifact = this.options.artifacts.saveEvidence(runId, `browser/capture-${randomUUID()}.jpg`, await s.page.screenshot({ type: 'jpeg', quality: 65 }));
    else if (action.action === 'scroll') {
      if (action.target) await locate().hover({ timeout: 2000 });
      await s.page.mouse.wheel(action.deltaX ?? 0, action.deltaY ?? 600);
    }
    else if (action.action === 'hover') await locate().hover({ timeout: 2000 });
    else if (['click', 'double_click', 'right_click', 'press', 'select', 'check', 'drag', 'fill', 'download', 'upload'].includes(action.action)) {
      const locator = locate();
      // Validate and resolve targets before recording an external effect. A stale
      // snapshot or bad tool argument is recoverable, not an uncertain submission.
      if (action.action === 'fill' && action.value === undefined && !action.secret) throw new Error('Supply a value.');
      if (action.action === 'press' && !action.key) throw new Error('Supply a supported key.');
      if (action.action === 'select' && action.value === undefined) throw new Error('Supply the option value.');
      if (action.action === 'check' && action.checked === undefined) throw new Error('Supply checked=true or false.');
      const destination = action.action === 'drag' ? locate(action.destination) : undefined;
      let upload: { name: string; mimeType: string; buffer: Buffer } | undefined;
      if (action.action === 'upload') {
        const types: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf', '.txt': 'text/plain' };
        if (action.desktopPath !== undefined) {
          // The file the bot downloaded lives on its own computer, not in this daemon.
          if (!s.readDesktopFile) throw new Error('Uploading by path needs this bot\'s own Linux computer. Use artifactId with sourceRunId for a stored artifact instead.');
          const buffer = await s.readDesktopFile(action.desktopPath);
          upload = { name: path.basename(action.desktopPath), mimeType: types[path.extname(action.desktopPath).toLowerCase()] ?? 'application/octet-stream', buffer };
        } else {
          if (!action.artifactId || !action.sourceRunId || this.options.store.getTaskRun(action.sourceRunId)?.agent_id !== agentId) throw new Error('Upload requires an artifact owned by this bot, or desktopPath for a file on this bot\'s computer.');
          const file = this.options.artifacts.read(action.sourceRunId, action.artifactId);
          if (!file) throw new Error('Upload artifact not found.');
          upload = { name: path.basename(file.path), mimeType: types[path.extname(file.path).toLowerCase()] ?? 'application/octet-stream', buffer: Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8') };
        }
      }
      let inputFile = false;
      let elementUrl = s.page.url();
      let href: string | null = null;
      try {
        await locator.waitFor({ state: action.target?.role === 'file' ? 'attached' : 'visible', timeout: 2000 });
        const element = await locator.evaluate(el => ({ file: el instanceof HTMLInputElement && el.type === 'file', url: el.ownerDocument.URL, href: el instanceof HTMLAnchorElement ? el.href : null }), undefined, { timeout: 2000 });
        inputFile = element.file;
        elementUrl = element.url;
        href = action.action === 'click' ? element.href : null;
        if(flow){await this.uniqueFlowTarget(s.page,flow.target);if(element.href)throw new FlowMiss('anchor','Learned controls must not be links.');}
        if (action.action === 'upload' && (inputFile || action.target?.role === 'file')) {
          if (!inputFile) throw new Error('Pick a file input.');
        } else if (action.action === 'fill') {
          if (!await locator.isEditable()) throw new Error('Pick an editable field.');
        } else await locator.click({ trial: true, timeout: 2000 });
        if (destination) await destination.click({ trial: true, timeout: 2000 });
      } catch(error) {
        if(error instanceof FlowMiss)throw error;
        if(flow)throw new FlowMiss('target','The learned target is not usable.');
        throw new Error('Browser target is missing, blocked or not usable for this action. Take a fresh snapshot and choose the current control; no interaction was dispatched.');
      }
      if(!action.secret&&['click','double_click','press','fill'].includes(action.action)){
        traceTarget=await this.recordedIdentity(s,locator,action).catch(()=>null);
        const probe=this.options.publishProbes?.find(p=>p.origins.includes(new URL(elementUrl).origin));
        traceAccount=probe?await this.accountOn(s.page,probe):null;
      }
      // Following a link executes a navigation, not an arbitrary onclick handler.
      if (action.action === 'click' && href) {traceHref=new URL(href,s.page.url()).href;traceLink=await this.linkContext(s.page,traceHref);await navigate(traceHref);}
      else {
        // Frame controls use the frame's site, not the top page's permission or credentials.
        const pageUrl = new URL(elementUrl);
        const origin = pageUrl.origin;
        // An account detail is resolved before anything is granted or dispatched,
        // so a refusal (wrong site, wrong kind of field) changes nothing.
        let value = action.value;
        if (action.secret) {
          if (action.action !== 'fill') throw new Error('secret is only used with fill.');
          if (action.value !== undefined) throw new Error('Use either value or secret, not both.');
          if (!this.options.accounts) throw new Error('Saved accounts are not available in this installation.');
          const field = await locator.evaluate((element) => element instanceof HTMLInputElement ? element.type.toLowerCase() : element.tagName.toLowerCase()).catch(() => null);
          // A password goes only into a password box - never a comment field on the same site.
          if (action.secret === 'password' && field !== 'password') throw new Error('The saved password is typed only into a password field. Pick the page\'s password box.');
          if (action.secret === 'username' && !['text', 'email', 'tel', 'search'].includes(field ?? '')) throw new Error('The saved username is typed only into a username or email box. Pick that field.');
          value = await this.options.accounts.secretFor(agentId, pageUrl.href, action.secret, action.account);
          s.typed.set(value, action.secret === 'password' ? '[saved password]' : '[saved username]');
        }
        if (!s.writes.has(origin)) {
          const allowed = this.autonomyAllows(agentId, pageUrl.hostname);
          if (allowed) {
            s.writes.add(origin);
            this.emit(s, 'BROWSER_INTERACTION_ALLOWED', { origin, autonomy: allowed, reason: allowed === 'always' ? 'This bot is set to use websites without asking.' : 'This bot has a saved account for this site.' });
          } else {
            if (!this.options.approvals) throw new Error('Browser interaction needs an approval gate.');
            const permission = await this.options.approvals.request({ taskRunId: runId, agentId, kind: 'browser-interaction', payload: { origin, scope: 'Interact with forms and controls on this origin for this run; submissions can change external state.', action: action.action, target: action.target }, timeoutMs: 60000, abortSignal: signal });
            if (permission.status !== 'APPROVED') throw new Error('Browser interaction was not approved.');
            s.writes.add(origin);
          }
        }
        // The bot's own non-secret text, in memory only, so a write that echoes it can be recognised (spec 6.2).
        if (action.action === 'fill' && !action.secret && value !== undefined) s.run.watch.noteFill(value);
        const actionId = randomUUID();
        if(flow?.commit){await this.guardFlowCommit(s,flow.commit,signal);s.run.expectedAccount=flow.commit.account;s.run.watch.expect({actionId,text:flow.commit.expectText,inReplyTo:flow.commit.inReplyTo});}
        if(flow)flow.dispatchedAt=Date.now();
        this.emit(s, 'EXTERNAL_ACTION_STARTED', { actionId, transport: 'browser', origin, action: action.action });
        s.run.watch.beginAction(actionId, flow?'flow':'model', action.action, Date.now());
        dispatchedActionId = actionId;
        publishActionId = actionId;
        publishOrigin = origin;
        try {
          if (action.action === 'fill') { if(flow?.fillMethod==='insertText'){await locator.focus();await locator.press('ControlOrMeta+A');await s.page.keyboard.insertText(value!);}else await locator.fill(value!); }
          else if (action.action === 'upload') {
            if (inputFile) await locator.setInputFiles(upload!);
            else {
              const [chooser] = await Promise.all([s.page.waitForEvent('filechooser'), locator.click()]);
              await chooser.setFiles(upload!);
            }
          } else if (action.action === 'download') {
            const [download] = await Promise.all([s.page.waitForEvent('download'), locator.click()]);
            // The click produced a download. A later retention error is a file
            // error, not evidence that an external submission may be repeated.
            this.emit(s, 'EXTERNAL_ACTION_FINISHED', { actionId, transport: 'browser' });
            s.run.watch.endAction(actionId, Date.now());
            dispatchedActionId = undefined;
            try {
              let body: Buffer;
              if (s.desktopDownloads && s.fetchDesktopDownload) {
                // Playwright would read this file from a daemon-local path, but Chrome wrote it
                // inside the desktop container, so the bytes are fetched from there instead.
                const wanted = download.suggestedFilename();
                const deadline = Date.now() + 120_000;
                let guid: string | undefined;
                while (!guid && Date.now() < deadline) {
                  for (const [candidate, entry] of s.desktopDownloads)
                    if (entry.suggestedFilename === wanted && entry.state === 'completed') { guid = candidate; break; }
                  for (const [, entry] of s.desktopDownloads)
                    if (entry.suggestedFilename === wanted && entry.state === 'canceled') throw new Error(`The browser cancelled the download of "${wanted}".`);
                  if (!guid) await new Promise(resolve => setTimeout(resolve, 200));
                }
                if (!guid) throw new Error(`The download of "${wanted}" did not finish inside the bot desktop within two minutes.`);
                s.desktopDownloads.delete(guid);
                body = await s.fetchDesktopDownload(wanted);
                if (body.length > MAX_BROWSER_DOWNLOAD_BYTES) throw new Error('Download exceeds 8 MiB. Choose a smaller file.');
              } else {
                const stream = await download.createReadStream(); const chunks: Buffer[] = []; let size = 0;
                for await (const chunk of stream) { size += chunk.length; if (size > MAX_BROWSER_DOWNLOAD_BYTES) { await download.cancel(); throw new Error('Download exceeds 8 MiB. Choose a smaller file.'); } chunks.push(Buffer.from(chunk)); }
                body = Buffer.concat(chunks);
              }
              const size = body.length;
              const failure = await download.failure();
              if (failure) throw new Error(`The browser did not finish downloading "${download.suggestedFilename()}": ${failure}`);
              // Chrome can complete a download onto its own filesystem while none of the
              // bytes reach this daemon. Saving an empty artifact would present a file that
              // does not exist, so an empty read is reported as the failure it is.
              if (size === 0) throw new Error(`The download of "${download.suggestedFilename()}" reached this bot with no bytes, so no file was saved. The browser may have stored it only inside its own environment. Do not treat it as a downloaded file.`);
              const name = path.basename(download.suggestedFilename()).replace(/[^a-zA-Z0-9_.-]/g, '_') || 'download.bin';
              artifact = this.options.artifacts.saveDownload(runId, `${randomUUID()}-${name}`, body);
            } finally { await download.delete().catch(() => {}); }
          } else if (action.action === 'select') await locator.selectOption(action.value!);
          else if (action.action === 'check') await locator.setChecked(action.checked!);
          else if (action.action === 'drag') await locator.dragTo(destination!);
          else if (action.action === 'double_click') await locator.dblclick();
          else if (action.action === 'right_click') await locator.click({ button: 'right' });
          else if (action.action === 'press') await locator.press(action.key!);
          else await locator.click();
          // Test seam: a throw here is a failure after dispatch (spec 6.3).
          await this.options.testHooks?.afterDispatch?.(actionId, action.action);
        } catch (error) {
          if (!dispatchedActionId) throw error;
          if(flow?.commit){await this.settleFlowCommit(s,dispatchedActionId,flow.commit,signal,flow.dispatchedAt!);dispatchedActionId=undefined;}
          // Rescue (spec 6.6): X's response proves the post, so the action finished despite the failure after dispatch.
          else if (await this.rescuedByResponse(s, dispatchedActionId, action.action, origin, signal)) dispatchedActionId = undefined;
          else { s.run.watch.endAction(dispatchedActionId, Date.now()); throw new UncertainExternalEffect(); }
        }
      }
    }
    try {
      // Model-click evidence (spec 6.3 item 5): up to 5 s for X's answer, before the observation snapshot.
      if(dispatchedActionId&&flow?.commit){const id=dispatchedActionId;dispatchedActionId=undefined;await this.settleFlowCommit(s,id,flow.commit,signal,flow.dispatchedAt!);}
      else if (dispatchedActionId && publishOrigin && ['click', 'double_click', 'press'].includes(action.action)) await this.awaitPublishVerdict(s, dispatchedActionId, publishOrigin, signal);
      signal.throwIfAborted();
      if (artifact) this.emit(s, 'BROWSER_EVIDENCE', artifact);
      const snapshot = this.redact(s, await (action.action === 'snapshot' && action.target ? locate().ariaSnapshot({ mode: 'ai' }) : s.page.ariaSnapshot({ mode: 'ai' }))).slice(0, 24000);
      s.refs = new Set([...snapshot.matchAll(/\[ref=([a-z0-9]+)\]/g)].map(match => match[1]));
      const currentUrl = this.redact(s, s.page.url());
      const currentTitle = this.redact(s, await s.page.title().catch(() => ''));
      const tabs = s.context.pages().map((page, index) => ({ index, url: this.redact(s, page.url()) }));
      const frames = s.page.frames().map((frame, index) => ({ index, url: this.redact(s, frame.url()) }));
      const fileInputs = (await Promise.all(s.page.frames().slice(0, 51).map(async (frame, frameIndex) => {
        const inputs = await frame.locator('input[type="file"]').evaluateAll(inputs => inputs.slice(0, 51).map((el, index) => ({ index, accept: el.getAttribute('accept') ?? '', multiple: el.hasAttribute('multiple') }))).catch(() => []);
        return inputs.map(input => ({ ...input, frame: frameIndex }));
      }))).flat();
      // Read after the snapshot, so a request that arrived meanwhile is reported (as pending).
      const publish = publishActionId ? this.publishField(s.run.watch, publishActionId) : undefined;
      const result = { url: currentUrl, title: currentTitle, snapshot, tabs, artifact, fileInputs, frames, ...(publish ? { publish } : {}) };
      signal.throwIfAborted();
      
      let screenBuffer: Buffer | null = null;
      try {
        screenBuffer = await s.page.screenshot({ type: 'jpeg', quality: 55 });
      } catch {
        screenBuffer = null;
      }
      if (screenBuffer) {
        s.lastScreenshot = screenBuffer;
      }
      const screenshotBase64 = screenBuffer
        ? `data:image/jpeg;base64,${screenBuffer.toString('base64')}`
        : (s.lastScreenshot ? `data:image/jpeg;base64,${s.lastScreenshot.toString('base64')}` : undefined);

      s.lastState = {
        url: result.url,
        title: result.title,
        tabs: result.tabs,
        screenshot: screenshotBase64,
        // The page text the model actually read. Only a screenshot was kept before, so when
        // a run clicked the wrong control there was no way to see what it had been looking
        // at - not for the operator, and not for anything measuring those decisions later.
        // This is the same string already given to the model: redacted of typed account
        // details by redact(), and capped at 24000 characters, upstream.
        snapshot: (result as { snapshot?: string }).snapshot,
        action: action.action,
        target: (action as any).target?.name ?? (action as any).url ?? undefined,
        timestamp: Date.now(),
      };
      this.emit(s, 'BROWSER_STATE', s.lastState);
      // A dispatched click alone is not confirmation: capture its resulting page before closing the intent record.
      if (dispatchedActionId) { this.emit(s, 'EXTERNAL_ACTION_FINISHED', { actionId: dispatchedActionId, transport: 'browser' }); s.run.watch.endAction(dispatchedActionId, Date.now()); }
      s.needsObservation = false;
      s.observationReason = undefined;
      if(traceHref)this.appendTrace(s,{kind:'navigate',via:flow?'flow':action.action==='navigate'?'navigate':'anchor',href:traceHref,fromUrl,toUrl:s.page.url(),link:traceLink,pick:flow?.pick,at:traceAt});
      else if(action.secret||['new_tab','use_tab','close_tab','right_click','upload','download','select','check','drag'].includes(action.action))this.appendTrace(s,{kind:'other',action:action.action,...(action.secret?{secret:true}:{}),at:traceAt});
      else if(publishActionId&&['click','double_click','press','fill'].includes(action.action))this.appendTrace(s,{kind:action.action as 'click'|'double_click'|'press'|'fill',target:traceTarget,key:action.key,valueSha256:action.action==='fill'?textSha256(action.value??''):undefined,account:traceAccount,fromUrl,toUrl:s.page.url(),actionId:publishActionId,by:flow?'flow':'model',at:traceAt});
      return result;
    } catch (error) {
      if (dispatchedActionId) { s.run.watch.endAction(dispatchedActionId, Date.now()); throw new UncertainExternalEffect(); }
      throw error;
    }
  }

  /** Waits up to 5 s for the verdict of a probed publish this action sent (spec 6.3 item 5). */
  private async settleFlowCommit(s:Session,actionId:string,commit:Extract<PlayStep,{kind:'commit'}>,signal:AbortSignal,dispatchedAt:number) {
    const watch=s.run.watch;
    const finish=(outcome:string,record?:PublishRecord)=>{this.emit(s,'EXTERNAL_ACTION_FINISHED',{actionId,transport:'browser',outcome,publishId:record?.publishId,confirmedBy:record?.confirmedBy});watch.endAction(actionId,Date.now());};
    try {
      while(!watch.forAction(actionId).length&&!watch.refusedFor(actionId)&&Date.now()<dispatchedAt+5000)await pause(25,signal);
      if(watch.refusedFor(actionId)){finish('not-sent');throw new CommitNotSent('The publication request was held back.');}
      if(!watch.forAction(actionId).length)throw new UncertainExternalEffect();
      await watch.settle(actionId,dispatchedAt+15000,signal);
      let record=watch.forAction(actionId).at(-1)!;
      if(record.state==='unobserved'&&Date.now()<dispatchedAt+15000&&!watch.all().some(r=>r.state==='pending')){
        const bounded=AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,dispatchedAt+15000-Date.now()))]);
        await this.checkPublished(s,s.run,record,commit.account,bounded);record=watch.forAction(actionId).at(-1)!;
      }
      if(record.state==='confirmed'){finish('confirmed',record);return record;}
      if(record.state==='rejected'){finish('rejected',record);throw new CommitRejected('The site rejected the post.');}
      throw new UncertainExternalEffect();
    }catch(error){
      if(error instanceof CommitRejected||error instanceof CommitNotSent)throw error;
      const confirmed=watch.forAction(actionId).find(r=>r.state==='confirmed'&&r.confirmedBy==='response');
      if(confirmed){finish('confirmed',confirmed);return confirmed;}
      watch.endAction(actionId,Date.now());throw new UncertainExternalEffect();
    }
  }
  async play(agentId:string,runId:string,step:PlayStep,signal:AbortSignal):Promise<PlayResult> {
    return this.withLease(agentId,runId,signal,async s=>{
      const began=Date.now();if(s.needsObservation)throw new FlowMiss('operator','Take a fresh observation after owner input.');
      if(step.kind==='visit') {
        const expected=new URL(step.url);if(!['https:','http:'].includes(expected.protocol)||expected.username||expected.password)throw new FlowMiss('goto','Invalid learned URL.');
        try{await this.performCall(s,browserAction.parse({tool:'browser',action:'navigate',url:step.url}),signal,{target:{role:'main',name:'',scope:null},pick:step.pick});}
        catch(error){if(signal.aborted)throw error;throw new FlowMiss('goto','Could not open the learned page.');}
        const actual=new URL(s.page.url());if(actual.origin!==expected.origin||actual.pathname!==expected.pathname||/^\/(?:i\/flow\/login|login)/.test(actual.pathname))throw new FlowMiss('redirect','The learned page redirected.');
        const deadline=Date.now()+15000;
        while(true){
          signal.throwIfAborted();let ready=false;
          try {
            if('target' in step.ready)ready=await (await this.uniqueFlowTarget(s.page,step.ready.target)).isVisible();
            else if('links' in step.ready){const spec=step.ready.links;ready=await s.page.getByRole(spec.container as any).evaluateAll((els,p)=>els.filter(el=>[...el.querySelectorAll('a[href]')].some(a=>new RegExp(p.pattern).test(new URL((a as HTMLAnchorElement).href).pathname))).length,spec)>=spec.min;}
            else {const text=(await s.page.getByRole('main').innerText({timeout:500})).trim();ready=text.length>=step.ready.text.minChars&&!/^loading[.\s…]*$/i.test(text);}
          }catch{/* Bounded readiness polling. */}
          if(ready)break;if(Date.now()>=deadline)throw new FlowMiss('not-ready','The learned page is not ready.');await pause(250,signal);
        }
        const result:PlayResult={url:s.page.url(),ms:Date.now()-began};
        if(step.extract?.context)result.context=this.redact(s,await s.page.getByRole('main').innerText({timeout:2000})).replace(/\s+/g,' ').slice(0,3000);
        if(step.extract?.account){const a=s.page.getByRole(step.extract.account.role as any,{name:step.extract.account.name,exact:true});result.account=await a.count()===1?(await a.getAttribute('href'))?.match(/^\/?([A-Za-z0-9_]+)\/?$/)?.[1]??null:null;}
        if(step.extract?.candidates){const spec=step.extract.candidates,excluded=new Set(spec.exclude),recent=s.run.policy?.recent;
          const rows=await s.page.getByRole(spec.container as any).evaluateAll((els,p)=>els.flatMap(el=>{const a=[...el.querySelectorAll('a[href]')].find(a=>new RegExp(p.pattern).test(new URL((a as HTMLAnchorElement).href).pathname)) as HTMLAnchorElement|undefined;return a?[{href:a.href,text:(el as HTMLElement).innerText}]:[];}).slice(0,40),spec);
          result.candidates=rows.filter(r=>{const u=new URL(r.href);return u.origin===expected.origin&&!excluded.has(r.href)&&!!statusIdOf(u.pathname)&&!recent?.targets.has(statusIdOf(u.pathname)!)&&(!result.account||u.pathname.split('/')[1]?.toLowerCase()!==result.account.toLowerCase());}).slice(0,Math.min(12,spec.max)).map((r,i)=>({id:i+1,href:r.href,text:this.redact(s,r.text).replace(/\s+/g,' ').slice(0,300)}));
        }
        // Refresh refs after readiness without adding an observation-only trace entry.
        await this.performCall(s,browserAction.parse({tool:'browser',action:'snapshot'}),signal);
        return result;
      }
      const action=browserAction.parse({tool:'browser',action:step.kind==='commit'?'click':step.kind,target:{role:step.target.role,name:step.target.name},...(step.kind==='fill'?{value:step.value}:{}),...(step.kind==='press'?{key:step.key}:{})});
      await this.performCall(s,action,signal,{target:step.target,...(step.kind==='fill'?{fillMethod:step.method}:{}),...(step.kind==='commit'?{commit:step}:{})});
      return {url:s.page.url(),ms:Date.now()-began,...(step.kind==='commit'?{publish:s.run.watch.all().filter(r=>r.by==='flow'&&r.state==='confirmed').at(-1)}:{})};
    });
  }
  private async awaitPublishVerdict(s: Session, actionId: string, origin: string, signal: AbortSignal) {
    if (!this.options.publishProbes?.some(probe => probe.origins.includes(origin))) return;
    const watch = s.run.watch;
    const deadline = Date.now() + 5000;
    // The route sees the page's request a moment after the click returns; wait briefly for it to be attributed.
    const grace = Date.now() + PUBLISH_ATTRIBUTION_GRACE_MS;
    while (!watch.forAction(actionId).length && !watch.refusedFor(actionId) && Date.now() < grace && !signal.aborted) await delay(25);
    if (watch.forAction(actionId).some(record => record.state === 'pending' && !record.unprobed)) await watch.settle(actionId, deadline, signal);
  }
  /** Rescue (spec 6.6): true, with FINISHED recorded, when X's response confirmed a post of this action. */
  private async rescuedByResponse(s: Session, actionId: string, kind: string, origin: string, signal: AbortSignal): Promise<boolean> {
    if (['click', 'double_click', 'press'].includes(kind)) await this.awaitPublishVerdict(s, actionId, origin, signal);
    const confirmed = s.run.watch.forAction(actionId).find(record => record.state === 'confirmed' && record.confirmedBy === 'response');
    if (!confirmed) return false;
    this.emit(s, 'EXTERNAL_ACTION_FINISHED', { actionId, transport: 'browser', outcome: 'confirmed', confirmedBy: 'response', publishId: confirmed.publishId });
    s.run.watch.endAction(actionId, Date.now());
    return true;
  }
  /** The call result's publish field: the action's latest record, or its route refusal. */
  private publishField(watch: PublishWatch, actionId: string): PublishField | undefined {
    const latest = watch.forAction(actionId).at(-1);
    if (latest) return { state: latest.state, op: latest.op, ...(latest.postUrl ? { postUrl: latest.postUrl } : {}), ...(latest.reason ? { reason: latest.reason } : {}) };
    const refused = watch.refusedFor(actionId);
    return refused ? { state: 'refused', op: refused.op, reason: refused.reason } : undefined;
  }

  /**
   * Read-only check for our own new post (spec 6.5). It never types or clicks, and it navigates only in
   * phase 2, when no post of the run is still pending. With no live session it is 'not-found' without an event.
   */
  async confirmPublish(agentId: string, runId: string, publishId: string, account: string | null, signal: AbortSignal): Promise<'present' | 'not-found'> {
    const run = this.runs.get(runId);
    const record = run?.watch.all().find(r => r.publishId === publishId);
    if (!run || !record) return 'not-found';
    if (record.state === 'confirmed') return 'present';
    try {
      return await this.withLease(agentId, runId, signal, s => this.checkPublished(s, run, record, account, signal), { waitForLease: true, reuseOnly: true });
    } catch (error) {
      if (error instanceof NoSession) return 'not-found';
      throw error;
    }
  }

  /**
   * Settle and check every post of the run before it ends (spec 6.10). It resolves with the records as they
   * stand when its signal fires, never opens a browser and never throws UncertainExternalEffect.
   */
  async closeOutPublishes(agentId: string, runId: string, signal: AbortSignal): Promise<readonly PublishRecord[]> {
    const run = this.runs.get(runId);
    if (!run) return [];
    try {
      await this.withLease(agentId, runId, signal, async s => {
        // track() settles every record by sentAt + 20 s.
        await run.watch.allSettled(Math.max(Date.now(), ...run.watch.all().map(r => r.sentAt + 20_000)) + 1000, signal);
        for (const record of run.watch.all()) {
          signal.throwIfAborted();
          // model, operator and page records pass account null; Stage 2 passes run.expectedAccount for by:'flow'.
          if (record.state === 'unobserved' && run.watch.textFor(record) !== undefined) await this.checkPublished(s, run, record, record.by==='flow'?run.expectedAccount??null:null, signal);
        }
      }, { waitForLease: true, reuseOnly: true });
    } catch {
      // No session, the signal, or a failed page read: each only leaves a record unresolved, and the records are the result.
    }
    return run.watch.all();
  }

  /** The page check itself (spec 6.5), under a lease its caller already holds. */
  private async checkPublished(s: Session, run: RunRecord, record: PublishRecord, account: string | null, signal: AbortSignal): Promise<'present' | 'not-found'> {
    const probe = this.options.publishProbes?.find(p => p.id === record.probe);
    const notFound = () => { this.emit(s, 'PUBLISH_RECONCILED', { publishId: record.publishId, verdict: 'not-found', by: 'page-check' }); return 'not-found' as const; };
    if (!probe) return notFound();
    const handle = account ?? await this.accountOn(s.page, probe);
    if (!handle) return notFound();
    const text = run.watch.textFor(record);
    if (text === undefined) return notFound();
    const found = async () => {
      const id = await this.findOwnPost(s.page, record, handle, text);
      if (id) run.watch.markConfirmedByPage(record.publishId, record.origin + probe.postPath(handle, id));
      return !!id;
    };
    // Phase 1: the current page, every 250 ms until 15 s after the request.
    for (;;) {
      signal.throwIfAborted();
      if (await found()) return 'present';
      if (Date.now() >= record.sentAt + 15_000) break;
      await pause(250, signal);
    }
    // Phase 2 navigates, so it never runs while a post of this run is still in flight.
    if (run.watch.anyPending()) return notFound();
    const op: ProbedRequest['op'] = record.op === 'post' || record.op === 'reply' ? record.op : 'unknown';
    for (const path of probe.profilePaths(handle, op)) {
      await raceAbort(s.page.goto(record.origin + path, { waitUntil: 'domcontentloaded' }), signal);
      this.requireFreshObservation(s.agentId, s.runId, PAGE_CHECK_NAVIGATED);
      const ready = Date.now() + 15_000;
      while (Date.now() < ready && !(await this.profileReady(s.page))) await pause(250, signal);
      const until = Date.now() + 10_000;
      for (;;) {
        signal.throwIfAborted();
        if (await found()) return 'present';
        if (Date.now() >= until) break;
        await pause(250, signal);
      }
    }
    return notFound();
  }

  /** One DOM read of the articles. Filtering happens here in Node, never in the page and never over the aria snapshot. */
  private async findOwnPost(page: Page, record: PublishRecord, handle: string, text: string): Promise<string | null> {
    const articles = await page.evaluate(() => [...document.querySelectorAll('article')].slice(0, 50).map(article => ({
      links: [...article.querySelectorAll('a[href]')].slice(0, 30).map(a => ({ origin: (a as HTMLAnchorElement).origin, path: (a as HTMLAnchorElement).pathname })),
      text: (article as HTMLElement).innerText.slice(0, 4000),
    }))).catch(() => [] as Array<{ links: Array<{ origin: string; path: string }>; text: string }>);
    const own = new RegExp('^/' + handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/status/(\\d+)$', 'i');
    for (const article of articles) {
      if (!matchesPostText(text, article.text)) continue;
      for (const link of article.links) {
        const id = link.origin === record.origin ? own.exec(link.path)?.[1] : undefined;
        const at = id ? snowflakeMs(id) : null;
        if (id && at !== null && at >= record.sentAt - 30_000) return id;
      }
    }
    return null;
  }

  /** A profile page is ready when an article has a status link and no lone "Loading…" remains. */
  private async profileReady(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      const hasPost = [...document.querySelectorAll('article a[href]')].some(a => /\/status\/\d+$/.test((a as HTMLAnchorElement).pathname));
      const loading = [...document.querySelectorAll('body *')].some(el => el.childElementCount === 0 && el.textContent?.trim() === 'Loading…');
      return hasPost && !loading;
    }).catch(() => false);
  }

  async waitForOperator(runId: string, signal: AbortSignal) {
    const s = this.sessions.get(runId);
    while (s?.controlled) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { s.resume = undefined; reject(signal.reason); };
        s.resume = () => { signal.removeEventListener('abort', abort); resolve(); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); }
      });
    }
    if (s?.controlEnded) throw s.controlEnded;
  }

  getLatestScreenshot(runIdOrAgentId: string): Buffer | null {
    const byRun = this.sessions.get(runIdOrAgentId);
    if (byRun?.lastScreenshot) return byRun.lastScreenshot;
    for (const s of this.sessions.values()) {
      if (s.agentId === runIdOrAgentId && s.lastScreenshot) return s.lastScreenshot;
    }
    return null;
  }

  /** Fresh frames are operator-only HTTP responses, never durable event payloads. */
  async liveState(agentId: string) {
    const human = [...this.humanDesktops].find(([, s]) => s.agentId === agentId && s.ready);
    if (human) return { available: true, state: { runId: human[0], login: true, desktop: true, url: human[1].url } };
    const s = [...this.sessions.values()].find(s => s.agentId === agentId);
    if (!s) return this.desktopObserve(agentId)?{available:true,state:{runId:`desktop:${agentId}`,desktop:true,url:'',controlled:false}}:{ available: false, state: null };
    if (this.loginRuns.get(agentId) === s.runId) return { available: true, state: { runId: s.runId, login: true, desktop: !!s.desktop, url: this.redact(s, s.page.url()), warning: s.navigationError } };
    if(s.desktop)return {available:true,state:{runId:s.runId,desktop:true,url:this.redact(s,s.page.url()),controlled:!!s.controlled,busy:!!s.actionDone,action:s.lastState?.action,timestamp:Date.now(),warning:s.navigationError}};
    if (!s.frame) s.frame = (async () => {
      if (s.page.isClosed()) s.page = s.context.pages()[0] ?? await s.context.newPage();
      const screenshot = await s.page.screenshot({ type: 'jpeg', quality: 60, timeout: 5000 });
      return { runId: s.runId, url: this.redact(s, s.page.url()), title: this.redact(s, await s.page.title()),
        tabs: s.context.pages().map((p, index) => ({ index, url: this.redact(s, p.url()) })),
        screenshot: `data:image/jpeg;base64,${screenshot.toString('base64')}`, width: s.page.viewportSize()?.width ?? (await s.page.evaluate(() => innerWidth)), height: s.page.viewportSize()?.height ?? (await s.page.evaluate(() => innerHeight)), desktop: !!s.desktop,
        controlled: !!s.controlled, busy: !!s.actionDone, login: this.loginRuns.get(agentId) === s.runId,
        action: s.lastState?.action, timestamp: Date.now(), warning: s.navigationError };
    })().finally(() => { s.frame = undefined; });
    return { available: true, state: await s.frame };
  }

  /** Coordinates human input with the model, keeping each bot's context and proxy. */
  desktopAccess(agentId: string) {
    const human = [...this.humanDesktops].find(([, s]) => s.agentId === agentId && s.ready);
    if (human && !this.closing.has(human[0])) return this.options.desktop?.endpoint(agentId) ?? null;
    const session = [...this.sessions.values()].find(s => s.agentId === agentId);
    return session?.desktop && !session.actionDone && (session.loginSite || session.controlled) && !this.closing.has(session.runId) ? this.options.desktop?.endpoint(agentId) ?? null : null;
  }

  /** Watching never starts a desktop or obtains its interactive control lease. */
  desktopObserve(agentId: string) {
    return this.options.desktop?.endpoint(agentId) ?? null;
  }

  desktopOnRevoke(agentId: string, close: () => void) {
    const callbacks = this.viewerRevocations.get(agentId) ?? new Set<() => void>();
    callbacks.add(close); this.viewerRevocations.set(agentId, callbacks);
    return () => { callbacks.delete(close); if (!callbacks.size) this.viewerRevocations.delete(agentId); };
  }
  private revokeDesktop(agentId: string) { for (const close of this.viewerRevocations.get(agentId) ?? []) close(); }

  /** Coordinates human input with the model, keeping each bot's context and proxy. */
  async control(agentId: string, input: { action: string; x?: number; y?: number; text?: string; key?: string; url?: string; tab?: number; delta?: number }) {
    const s = [...this.sessions.values()].find(s => s.agentId === agentId);
    if (!s) throw new Error('This bot has no open browser.');
    const operation = (s.operatorDone ?? Promise.resolve()).catch(() => {}).then(() => this.performControl(s, input));
    s.operatorDone = operation;
    try { return await operation; } finally { if (s.operatorDone === operation) s.operatorDone = undefined; }
  }
  private async performControl(s: Session, input: { action: string; x?: number; y?: number; text?: string; key?: string; url?: string; tab?: number; delta?: number }) {
    const agentId = s.agentId;
    s.signal.throwIfAborted();
    if (!this.sessions.has(s.runId)) throw new Error('The browser task has ended.');
    if (this.loginRuns.get(agentId) === s.runId) throw new Error('Use the separate sign-in window to enter account details.');
    if (input.action === 'takeover') {
      s.controlled = true;
      await s.actionDone;
      s.signal.throwIfAborted();
      // On the bot desktop the owner acts on the live desktop stream, not through
      // control()'s input branch, so the takeover itself marks the operator's turn:
      // every request from here until the bot's next action is the operator's
      // (spec 6.2 item 3: tracked, charged to the budget, never refused).
      s.run.watch.noteOperatorInput(Date.now());
      s.run.policy?.character?.gate.invalidate('takeover');
      s.writes.add('*');
      s.needsObservation = true;
      s.observationReason = undefined;
      clearTimeout(s.idle);
      s.idle = setTimeout(() => { this.revokeDesktop(agentId); s.writes.delete('*'); s.controlled = false; s.resume?.(); s.resume = undefined; this.armIdleCleanup(s); }, 30 * 60_000);
      this.emit(s, 'BROWSER_CONTROL', { operator: true });
      return { controlled: true };
    }
    if (!s.controlled) throw new Error('Take control before interacting with the browser.');
    if (input.action === 'resume') {
      this.revokeDesktop(agentId);
      if (s.desktop) {
        for (const page of s.context.pages()) {
          if (await page.evaluate(() => document.visibilityState === 'visible').catch(() => false)) { s.page = page; break; }
        }
      }
      s.writes.delete('*'); s.controlled = false; s.resume?.(); s.resume = undefined;
      this.armIdleCleanup(s);
      this.emit(s, 'BROWSER_CONTROL', { operator: false });
      return { controlled: false };
    }
    // Only the human's direct input temporarily permits submissions. The model's
    // per-origin grants remain intact when control returns.
    {
      s.needsObservation = true;
      s.observationReason = undefined;
      // Attribution order only: the operator's text is never noted (spec 6.3 item 8).
      s.run.watch.noteOperatorInput(Date.now());
      this.emit(s, 'BROWSER_OPERATOR_INPUT', { action: input.action });
      if (input.action === 'click') await s.page.mouse.click(input.x!, input.y!);
      else if (input.action === 'type') { s.typed.set(input.text!, '[operator input]'); await s.page.keyboard.insertText(input.text!); }
      else if (input.action === 'key') await s.page.keyboard.press(input.key!);
      else if (input.action === 'scroll') await s.page.mouse.wheel(0, input.delta!);
      else if (input.action === 'navigate') {
        const url = new URL(input.url!);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use a website address without credentials.');
        await s.page.goto(url.href, { waitUntil: 'domcontentloaded' });
      } else if (input.action === 'tab') {
        const page = s.context.pages()[input.tab!]; if (!page) throw new Error('That tab was closed.'); s.page = page;
      } else throw new Error('Unknown browser control.');
    }
    return { controlled: true };
  }

  getLatestState(runIdOrAgentId: string): { url: string; title: string; tabs: Array<{ index: number; url: string }>; screenshot?: string; action?: string; target?: string; timestamp?: number } | null {
    const byRun = this.sessions.get(runIdOrAgentId);
    if (byRun?.lastState) return byRun.lastState;
    for (const s of this.sessions.values()) {
      if (s.agentId === runIdOrAgentId && s.lastState) return s.lastState;
    }
    return null;
  }

  private async saveSession(s: Session): Promise<void> {
    if (s.desktop) { this.stateErrors.delete(s.agentId); return; } // Chrome persists its own profile; never copy cookies to the host.
    if (s.signal.aborted || !(await this.options.secrets.availability()).available) throw new Error('Protected session storage is unavailable. Previous saved state was preserved.');
    try {
      const state = JSON.stringify(await s.context.storageState({ indexedDB: true }));
      if (Buffer.byteLength(state) > 512 * 1024) throw new Error('Browser state exceeded the 512 KiB session limit and was not saved.');
      const cipher = await this.options.secrets.protect(state);
      s.signal.throwIfAborted();
      this.options.store.getDatabase().prepare('INSERT INTO browser_sessions(agent_id,ciphertext,updated_at) VALUES (?,?,?) ON CONFLICT(agent_id) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at').run(s.agentId, cipher, Date.now());
      this.stateErrors.delete(s.agentId);
    } catch (error) {
      if (error instanceof Error && error.message.includes('512 KiB')) throw error;
      throw new Error('Browser session could not be saved. Previous saved state was preserved.');
    }
  }

  endRun(runId: string): Promise<void> {
    const pending = this.closing.get(runId); if (pending) return pending;
    const human = this.humanDesktops.get(runId);
    if (human) {
      this.revokeDesktop(human.agentId);
      const closing = this.options.desktop!.stopAgent(human.agentId).catch(error => {
        this.stateErrors.set(human.agentId, 'The sign-in desktop could not stop. Retry desktop shutdown.'); throw error;
      }).finally(() => {
        human.release(); this.humanDesktops.delete(runId);
        const job = this.loginJobs.get(runId);
        this.finishLoginRun(human.agentId, runId, job?.saved ? 'COMPLETED' : 'ABORTED');
        this.closing.delete(runId);
      });
      this.closing.set(runId, closing); return closing;
    }
    const s = this.sessions.get(runId); if (!s) return Promise.resolve();
    this.revokeDesktop(s.agentId);
    if (s.controlled) {
      s.controlEnded = new Error('The browser closed during human control. Check the task outcome before continuing.');
      s.controlled = false; s.resume?.(); s.resume = undefined;
    }
    clearTimeout(s.idle); clearTimeout(s.teardownTimer); s.signal.removeEventListener('abort', s.abort);
    const closing = (async () => {
      try {
        // Human login persists only through Save, never on close/cancel/disconnect.
        if (!s.loginSite && !this.loginJobs.has(runId) && !s.signal.aborted && (await this.options.secrets.availability()).available) await this.saveSession(s);
      } catch (error) { this.stateErrors.set(s.agentId, error instanceof Error ? error.message : 'Browser session could not be saved. Previous saved state was preserved.'); }
      finally {
        // Closing a CDP client only detaches. Ask real Chrome to exit cleanly
        // before Docker stops X/DBus, so its profile databases are flushed.
        if (s.desktop && s.browser.isConnected()) {
          try { const cdp = await s.browser.newBrowserCDPSession(); await cdp.send('Browser.close'); }
          catch { /* Chrome may disconnect immediately after accepting close. */ }
        }
        await s.browser.close().catch(() => {});
        try { await s.proxy.close(); }
        catch (error) { this.stateErrors.set(s.agentId, 'The browser closed but its desktop could not stop. Check desktop status before retrying.'); throw error; }
        finally {
          this.sessions.delete(runId); s.release();
          if (s.run.ephemeral && this.runs.get(runId) === s.run) this.runs.delete(runId);
          const job = this.loginJobs.get(runId);
          if (job) this.finishLoginRun(s.agentId, runId, job.saved && !s.signal.aborted && !this.stateErrors.has(s.agentId) ? 'COMPLETED' : 'ABORTED',
            this.stateErrors.get(s.agentId) ?? (s.signal.aborted ? String(s.signal.reason?.message ?? 'Sign-in cancelled.') : job.saved ? undefined : 'Sign-in closed without saving.'));
        }
      }
    })().finally(() => { this.closing.delete(runId); });
    this.closing.set(runId, closing); return closing;
  }
  async stop() {
    this.lifetime.abort(new Error('Browser service stopped.'));
    this.options.desktop?.cancelSetup();
    await Promise.allSettled(this.pendingOpen);
    await Promise.allSettled([...this.loginJobs.values()].map(job => job.opening));
    await Promise.all([...this.sessions.keys(), ...this.humanDesktops.keys()].map(id => this.endRun(id)));
  }
}
