import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_BYTES = 1024 * 1024;
export interface WebPage { url: string; title: string; text: string; capturedAt: string; truncated: boolean; links: Array<{ title: string; url: string }> }

/** DNS work cannot hold a cancelled run or a browser worker indefinitely. */
export async function resolveAddresses(host: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (isIP(host)) return [{ address: host, family: isIP(host) }];
  return new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
    const abort = () => finish(signal!.reason);
    const timer = setTimeout(() => finish(new Error('DNS lookup timed out.')), 5000);
    const finish = (error?: unknown, addresses?: Array<{ address: string; family: number }>) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(addresses!);
    };
    signal?.addEventListener('abort', abort, { once: true });
    void lookup(host, { all: true, family: 4 }).then(addresses => finish(undefined, addresses), finish);
  });
}

/** Public IPv4 egress only. IPv6-only sites are currently refused rather than bypassing this policy. */
export function publicAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}

const decode = (s: string) => s.replace(/&(?:amp|quot|apos|lt|gt|nbsp);|&#(\d+);|&#x([\da-f]+);/gi, (m, n, h) => {
  const cp = n ? Number(n) : h ? parseInt(h, 16) : 0;
  return n || h ? (cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '') : ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' }[m.toLowerCase()] ?? m);
});
const plain = (s: string) => decode(s.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Read-only network tool. DNS results are pinned to the socket, and every redirect is checked anew. */
export class WebResearch {
  constructor(private readonly options: { enabled?: boolean; previewOrigins?: string[] } = {}) {}
  get enabled() { return this.options.enabled !== false; }
  capabilities() { return { internet: this.enabled ? 'public web reading, web search and GitHub issue search' : 'disabled', network: 'public IPv4; no host files or private services' }; }

  async read(value: string, signal: AbortSignal): Promise<WebPage> {
    if (!this.enabled) throw new Error('Internet tools are disabled in this installation.');
    const response = await this.request(value, signal);
    const html = /html/i.test(response.type);
    const title = html ? plain(response.body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? response.url) : response.url;
    const text = html ? plain(response.body) : response.body;
    const links: WebPage['links'] = [];
    if (html) for (const match of response.body.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      if (links.length >= 20) break;
      try {
        let url = new URL(decode(match[1]), response.url);
        if (url.hostname.endsWith('duckduckgo.com') && url.searchParams.has('uddg')) url = new URL(url.searchParams.get('uddg')!);
        const label = plain(match[2]).slice(0, 180);
        if (label && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !links.some(link => link.url === url.href)) links.push({ title: label, url: url.href });
      } catch { /* Non-URL links are not executable tool input. */ }
    }
    return { url: response.url, title: title.slice(0, 200), text: text.slice(0, 24000), capturedAt: new Date().toISOString(), truncated: text.length > 24000, links };
  }

  async search(query: string, signal: AbortSignal): Promise<WebPage> {
    const response = await this.request(`https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`, signal);
    const items = [...response.body.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 8).map(match => {
      const item = match[1];
      const url = decode(item.match(/<link>([\s\S]*?)<\/link>/i)?.[1] ?? '').trim();
      const title = plain(item.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '');
      const description = plain(item.match(/<description>([\s\S]*?)<\/description>/i)?.[1] ?? '').slice(0, 1200);
      return { url, title, description };
    }).filter(item => /^https?:\/\//.test(item.url));
    if (!items.length) throw new Error('Web search returned no usable results. Try a known URL or GitHub issue search; a challenge page is not search evidence.');
    return { url: response.url, title: `Web search: ${query}`, text: JSON.stringify(items, null, 2), links: items.map(({ title, url }) => ({ title, url })), capturedAt: new Date().toISOString(), truncated: false };
  }

  async githubIssues(query: string, signal: AbortSignal): Promise<WebPage> {
    if (!this.enabled) throw new Error('Internet tools are disabled in this installation.');
    const response = await this.request(`https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=8`, signal);
    const data = JSON.parse(response.body);
    if (!Array.isArray(data.items)) throw new Error('GitHub did not return an issue search result.');
    const items = data.items.slice(0, 8).map((item: any) => ({ url: String(item.html_url), title: String(item.title).slice(0, 500), state: String(item.state), text: String(item.body ?? '').slice(0, 2000) }));
    return { url: response.url, title: `GitHub issues: ${query}`, text: JSON.stringify(items, null, 2), links: items.map(({ title, url }: { title: string; url: string }) => ({ title, url })), capturedAt: new Date().toISOString(), truncated: data.items.length > 8 };
  }

  private async request(value: string, signal: AbortSignal, redirects = 0): Promise<{ url: string; type: string; body: string }> {
    if (!this.enabled) throw new Error('Internet tools are disabled in this installation.');
    signal.throwIfAborted();
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an http(s) URL without embedded credentials.');
    const preview = (this.options.previewOrigins ?? []).includes(url.origin);
    if (!preview && url.port && !['80', '443'].includes(url.port)) throw new Error('Public web tools permit standard HTTP/HTTPS ports only.');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = await resolveAddresses(host, signal);
    signal.throwIfAborted();
    if (!addresses.length || (!preview && addresses.some(a => !publicAddress(a.address)))) throw new Error('This URL resolves to a private, reserved or unsupported network address.');
    const address = addresses[0];
    const response = await new Promise<{ status: number; location?: string; type: string; body: string }>((resolve, reject) => {
      const req = (url.protocol === 'https:' ? https : http).request(url, {
        method: 'GET', signal, family: address.family,
        headers: { 'User-Agent': 'OpenAgents/0.1 research', Accept: 'text/html,application/json,text/plain', 'Accept-Encoding': 'identity' },
        // Preserve hostname/TLS verification while preventing a second DNS resolution from changing the destination.
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      }, res => {
        const status = res.statusCode ?? 0, type = String(res.headers['content-type'] ?? '');
        if (status >= 300 && status < 400) { res.destroy(); resolve({ status, location: res.headers.location, type, body: '' }); return; }
        if (status !== 200) { res.destroy(); reject(new Error(`The site returned HTTP ${status}${status === 429 ? ' (rate limited)' : ''}.`)); return; }
        if (!/^(text\/|application\/(json|xml|rss\+xml|[^;]+\+json))/i.test(type)) { res.destroy(); reject(new Error('This URL is not a supported text page.')); return; }
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_BYTES) req.destroy(new Error('Page exceeds the 1 MiB research limit.')); else chunks.push(chunk); });
        res.on('end', () => resolve({ status, type, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      const timeout = setTimeout(() => req.destroy(new Error('The website request timed out.')), 15000);
      req.on('close', () => clearTimeout(timeout));
      req.on('error', reject); req.end();
    });
    if (response.status >= 300 && response.status < 400) {
      if (!response.location || redirects >= 4) throw new Error('The website redirected too many times or without a destination.');
      return this.request(new URL(response.location, url).href, signal, redirects + 1);
    }
    return { url: url.href, type: response.type, body: response.body };
  }
}
