/**
 * Accounts a bot signs in to by itself, and how freely it acts on websites.
 *
 * The owner wants to hand a bot the details for an account and have it log in
 * with its own browser, instead of signing in for it by hand. The details must
 * still never reach the model: a model reads untrusted pages, and anything it
 * can see, a page can ask it to repeat. So:
 *
 *   STORED       encrypted with the operating system's per-user protection
 *                (SecretStore), in this installation's database only.
 *   NEVER SEEN   the model is told an account's site and label, nothing more.
 *                To type a detail it asks the browser for `secret: "username"`
 *                or `"password"`; the daemon decrypts it and types it.
 *   ONE SITE     a detail is typed only on its own site or that site's
 *                subdomains, never on a page that merely asks for it.
 *
 * AUTONOMY is how freely the bot submits forms and presses buttons:
 *
 *   ask       every site needs the operator's approval, once per run (the
 *             behaviour before this).
 *   accounts  sites with a saved account need no approval; others still ask.
 *             The default: an account was given so the bot could use it.
 *   always    no approvals at all. The operator's explicit choice.
 */

import { randomUUID } from 'node:crypto';
import type { AgentStore } from './agent-store.js';
import type { SecretStore } from './secret-store.js';

export type BrowserAutonomy = 'ask' | 'accounts' | 'always';
export const BROWSER_AUTONOMY_DEFAULT: BrowserAutonomy = 'accounts';

export interface BrowserAccount {
  id: string;
  agentId: string;
  /** Lower-case hostname without a leading www., e.g. github.com. */
  site: string;
  label: string;
  createdAt: number;
  updatedAt: number;
}

/** "https://www.GitHub.com/login" and "github.com" are the same site. */
export function normaliseSite(input: string): string {
  const value = input.trim();
  if (!value) throw new Error('Name the website, for example github.com.');
  let hostname: string;
  try {
    hostname = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`).hostname;
  } catch {
    throw new Error(`"${value}" is not a website address.`);
  }
  hostname = hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (!hostname.includes('.') && hostname !== 'localhost') throw new Error(`"${value}" is not a website address.`);
  return hostname;
}

/** An account for github.com may be used on github.com and its subdomains, and nowhere else. */
export function siteMatches(accountSite: string, pageHostname: string): boolean {
  const host = pageHostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  return host === accountSite || host.endsWith(`.${accountSite}`);
}

export class BrowserAccounts {
  constructor(private readonly store: AgentStore, private readonly secrets: SecretStore) {
    store.getDatabase().exec(`CREATE TABLE IF NOT EXISTS bot_accounts (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, site TEXT NOT NULL, label TEXT NOT NULL,
      username_cipher TEXT NOT NULL, password_cipher TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(agent_id, site, label));`);
  }

  list(agentId: string): BrowserAccount[] {
    return (this.store.getDatabase().prepare('SELECT id, agent_id, site, label, created_at, updated_at FROM bot_accounts WHERE agent_id=? ORDER BY site, label').all(agentId) as Array<Record<string, unknown>>)
      .map((row) => ({ id: String(row.id), agentId: String(row.agent_id), site: String(row.site), label: String(row.label), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }));
  }

  hasSite(agentId: string, pageHostname: string): boolean {
    return this.list(agentId).some((account) => siteMatches(account.site, pageHostname));
  }

  /** Save or replace an account. The username and password are encrypted before they touch the database. */
  async save(agentId: string, input: { site: string; label?: string; username: string; password: string }): Promise<BrowserAccount> {
    if (!this.store.getAgent(agentId)) throw new Error('Unknown bot.');
    const site = normaliseSite(input.site);
    const label = (input.label ?? '').trim().slice(0, 80) || site;
    if (!input.username.trim()) throw new Error('Enter the username or email for this account.');
    if (!input.password) throw new Error('Enter the password for this account.');
    if (input.username.length > 500 || input.password.length > 2000) throw new Error('That username or password is too long.');
    const availability = await this.secrets.availability();
    if (!availability.available) throw new Error(availability.reason ?? 'Protected storage is unavailable on this computer, so accounts cannot be saved.');
    const [usernameCipher, passwordCipher] = await Promise.all([this.secrets.protect(input.username.trim()), this.secrets.protect(input.password)]);
    const now = Date.now();
    const db = this.store.getDatabase();
    const existing = db.prepare('SELECT id, created_at FROM bot_accounts WHERE agent_id=? AND site=? AND label=?').get(agentId, site, label) as { id: string; created_at: number } | undefined;
    const id = existing?.id ?? `acct-${randomUUID()}`;
    db.prepare(`INSERT INTO bot_accounts(id, agent_id, site, label, username_cipher, password_cipher, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(agent_id, site, label) DO UPDATE SET username_cipher=excluded.username_cipher, password_cipher=excluded.password_cipher, updated_at=excluded.updated_at`)
      .run(id, agentId, site, label, usernameCipher, passwordCipher, existing?.created_at ?? now, now);
    return this.list(agentId).find((account) => account.id === id)!;
  }

  remove(agentId: string, id: string): { removed: boolean } {
    const result = this.store.getDatabase().prepare('DELETE FROM bot_accounts WHERE agent_id=? AND id=?').run(agentId, id);
    return { removed: Number(result.changes) > 0 };
  }

  /**
   * One detail, decrypted, for the page the browser is on.
   *
   * Refuses when no account belongs to that page's site, or when the named
   * account is for another site - a login form on the wrong host is exactly
   * where a password must not go.
   */
  async secretFor(agentId: string, pageUrl: string, field: 'username' | 'password', accountId?: string): Promise<string> {
    let hostname: string;
    try { hostname = new URL(pageUrl).hostname; } catch { throw new Error('Open the sign-in page before typing account details.'); }
    const candidates = this.list(agentId).filter((account) => siteMatches(account.site, hostname));
    const account = accountId ? candidates.find((entry) => entry.id === accountId) : candidates[0];
    if (!account) {
      if (accountId && this.list(agentId).some((entry) => entry.id === accountId)) throw new Error(`That account is for another site, not ${hostname}. Its details are only typed on its own site.`);
      throw new Error(`No saved account for ${hostname}. Ask the operator to add one with request_account.`);
    }
    if (!accountId && candidates.length > 1) throw new Error(`Several accounts are saved for ${hostname}; name one with account:"id".`);
    const row = this.store.getDatabase().prepare('SELECT username_cipher, password_cipher FROM bot_accounts WHERE id=?').get(account.id) as { username_cipher: string; password_cipher: string };
    return this.secrets.unprotect(field === 'username' ? row.username_cipher : row.password_cipher);
  }
}

export function browserAutonomy(store: AgentStore, agentId: string): BrowserAutonomy {
  const row = store.getAgentData(agentId, 'browser-autonomy', 'settings');
  const value = row ? JSON.parse(row.data_json) : null;
  return value === 'ask' || value === 'accounts' || value === 'always' ? value : BROWSER_AUTONOMY_DEFAULT;
}

export function setBrowserAutonomy(store: AgentStore, agentId: string, value: unknown): BrowserAutonomy {
  if (value !== 'ask' && value !== 'accounts' && value !== 'always') throw new Error('Choose ask, accounts or always.');
  store.setAgentData({ agentId, key: 'browser-autonomy', category: 'settings', data: value });
  return value;
}
