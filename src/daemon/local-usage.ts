/**
 * Local provider usage.
 *
 * Coding agents that run on this machine write a session log for every
 * conversation, and those logs carry the token counts the provider actually
 * billed. Reading them gives a true picture of what has been spent here across
 * tools - not just what this daemon dispatched.
 *
 * The idea is taken from OpenUsage (https://github.com/robinebers/openusage,
 * MIT). None of its code is: it is a native Swift menu-bar application for
 * macOS, reading the macOS keychain and provider APIs. What carries over is the
 * observation that the logs are already on disk, and the readers below are
 * written from the on-disk formats.
 *
 * WHAT IS DELIBERATELY NOT READ. Every provider directory also holds
 * credentials - `.claude/.credentials.json`, `.codex/auth.json`. This module
 * globs `*.jsonl` under the session directories and nothing else, so no code
 * path here can reach them. Nothing read here leaves the machine: it is
 * summarised in the daemon and rendered by a page served on loopback.
 *
 * WHY AN INDEX. There are hundreds of these files and they run to hundreds of
 * megabytes; re-reading them per request would make the settings screen a
 * disk-bound operation. They are also append-only, which is the property that
 * makes an index worth having: a file that has grown is read from where the
 * last scan stopped, so a scan after the first one touches only new bytes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ------------------------------------------------------------------ types ---

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Codex reports reasoning tokens separately; Claude folds them into output. */
  reasoning: number;
  total: number;
}

export interface DayUsage {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  models: Record<string, TokenTotals>;
  totals: TokenTotals;
}

export interface ProviderUsage {
  id: string;
  label: string;
  /** Where the numbers came from, so a surprising figure can be traced. */
  root: string;
  sessionCount: number;
  days: DayUsage[];
  totals: TokenTotals;
  models: Record<string, TokenTotals>;
  firstSeen: number | null;
  lastSeen: number | null;
}

export interface UnavailableProvider {
  id: string;
  label: string;
  /** Stated plainly, so the UI never has to invent an explanation. */
  reason: string;
}

export interface LocalUsageReport {
  providers: ProviderUsage[];
  unavailable: UnavailableProvider[];
  /** How far back the scan looked. */
  windowDays: number;
  scannedAt: number;
  /** Bytes actually read this scan. Zero on a warm index means nothing changed. */
  bytesRead: number;
  /** True when the scan stopped early against its own limits. */
  truncated: boolean;
}

// ---------------------------------------------------------------- helpers ---

export function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
}

function addTotals(into: TokenTotals, from: TokenTotals): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.reasoning += from.reasoning;
  into.total += from.total;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function num(value: unknown): number {
  return isFiniteNumber(value) && value > 0 ? value : 0;
}

/**
 * The local calendar date for a timestamp.
 *
 * Local, not UTC: "what did I spend today" is a question about the operator's
 * day. Formatted by hand rather than via toISOString, which would shift the
 * date across midnight for anyone not on UTC.
 */
function localDate(ms: number): string {
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

// ------------------------------------------------------------ file index ---

interface FileEntry {
  /** Byte offset after the last COMPLETE line consumed. */
  offset: number;
  size: number;
  mtimeMs: number;
  /** Session-level model, where the format records it once rather than per line. */
  model: string | null;
  days: Record<string, Record<string, TokenTotals>>;
}

interface IndexFile {
  version: number;
  files: Record<string, FileEntry>;
}

const INDEX_VERSION = 3;

function readIndex(file: string): IndexFile {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as IndexFile;
    if (raw?.version === INDEX_VERSION && raw.files && typeof raw.files === 'object') return raw;
  } catch {
    // A corrupt or older index is not an error - it is a cold start.
  }
  return { version: INDEX_VERSION, files: {} };
}

function writeIndex(file: string, index: IndexFile): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Temp-and-rename: a half-written index would be discarded on next read,
    // which is safe but throws away the whole scan.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index));
    fs.renameSync(tmp, file);
  } catch {
    // An index that cannot be saved costs a slow next scan, nothing more.
  }
}

/** Every *.jsonl under a root, with its stats, newest first. */
function sessionFiles(root: string, olderThanMs: number): { file: string; stat: fs.Stats }[] {
  const found: { file: string; stat: fs.Stats }[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      // The extension filter is the reason no credential file can be reached.
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < olderThanMs) continue;
        found.push({ file: full, stat });
      } catch {
        // A file that vanished mid-walk is simply not there.
      }
    }
  };

  walk(root, 0);
  found.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return found;
}

/**
 * Read the new bytes of an append-only file, a line at a time.
 *
 * Returns the offset after the last COMPLETE line. A trailing fragment - a
 * session being written to right now - is left for the next scan rather than
 * parsed half-formed.
 */
function readNewLines(
  file: string,
  from: number,
  onLine: (line: string) => void
): { offset: number; bytesRead: number } {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return { offset: from, bytesRead: 0 };
  }

  const CHUNK = 1 << 20;
  const buffer = Buffer.allocUnsafe(CHUNK);
  /** Where in the file the next read starts. */
  let filePos = from;
  let bytesRead = 0;
  /** The trailing partial line, carried into the next chunk. */
  let carry = '';

  try {
    for (;;) {
      const got = fs.readSync(fd, buffer, 0, CHUNK, filePos);
      if (got <= 0) break;
      filePos += got;
      bytesRead += got;

      const text = carry + buffer.subarray(0, got).toString('utf-8');
      const lines = text.split('\n');
      // The final element is a fragment (or empty), never a complete line.
      carry = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) onLine(line);
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  // Stop short of the fragment, so the next scan re-reads it once it is whole.
  return { offset: filePos - Buffer.byteLength(carry, 'utf-8'), bytesRead };
}

// ---------------------------------------------------------------- readers ---

type LineHandler = (
  line: string,
  entry: FileEntry
) => void;

/** Record usage into a file entry's day/model buckets. */
function record(entry: FileEntry, date: string, model: string, tokens: TokenTotals): void {
  const day = (entry.days[date] ??= {});
  const bucket = (day[model] ??= emptyTotals());
  addTotals(bucket, tokens);
}

/**
 * Claude Code sessions.
 *
 * One JSON object per line. Assistant turns carry `message.model` and
 * `message.usage`, and the line's own `timestamp` dates it. Usage here is
 * per-turn, so it sums.
 */
const readClaudeLine: LineHandler = (line, entry) => {
  if (!line.includes('"usage"')) return;
  let row: any;
  try {
    row = JSON.parse(line);
  } catch {
    return;
  }
  const message = row?.message;
  const usage = message?.usage;
  if (!usage || typeof usage !== 'object') return;

  const model = typeof message.model === 'string' ? message.model : 'unknown';
  const at = Date.parse(row?.timestamp ?? '');
  if (!Number.isFinite(at)) return;

  const tokens: TokenTotals = {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens),
    reasoning: 0,
    total: 0,
  };
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  if (tokens.total === 0) return;

  record(entry, localDate(at), model, tokens);
};

/**
 * Codex sessions.
 *
 * `last_token_usage` is the DELTA for a turn and `total_token_usage` is the
 * running total for the session. Only the delta is summed - adding the
 * cumulative figure on every line would multiply a session's cost by the number
 * of turns in it.
 *
 * The model is recorded once on a session-meta line rather than on each usage
 * line, so it is remembered on the entry and reused.
 */
const readCodexLine: LineHandler = (line, entry) => {
  if (!line.includes('token_usage') && !line.includes('"model"')) return;
  let row: any;
  try {
    row = JSON.parse(line);
  } catch {
    return;
  }
  const payload = row?.payload;
  if (!payload || typeof payload !== 'object') return;

  if (typeof payload.model === 'string' && payload.model) entry.model = payload.model;

  const usage = payload?.info?.last_token_usage;
  if (!usage || typeof usage !== 'object') return;

  const at = Date.parse(row?.timestamp ?? '');
  if (!Number.isFinite(at)) return;

  const tokens: TokenTotals = {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cached_input_tokens),
    cacheWrite: num(usage.cache_write_input_tokens),
    reasoning: num(usage.reasoning_output_tokens),
    total: 0,
  };
  // `total_tokens` upstream already counts cached input inside input_tokens, so
  // it is recomputed here rather than trusted, to match the Claude reader.
  tokens.total = tokens.input + tokens.output + tokens.cacheWrite;
  if (tokens.total === 0) return;

  record(entry, localDate(at), entry.model ?? 'unknown', tokens);
};

interface ProviderSpec {
  id: string;
  label: string;
  root: string;
  handler: LineHandler;
}

function providerSpecs(home: string): ProviderSpec[] {
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      root: path.join(home, '.claude', 'projects'),
      handler: readClaudeLine,
    },
    {
      id: 'codex',
      label: 'Codex',
      root: path.join(home, '.codex', 'sessions'),
      handler: readCodexLine,
    },
  ];
}

/**
 * Tools whose usage is NOT readable here, and why.
 *
 * Listed rather than omitted: an operator who uses Cursor should be told that
 * its absence is a limitation, not evidence that they spent nothing.
 */
function unavailableProviders(home: string): UnavailableProvider[] {
  const list: UnavailableProvider[] = [];

  if (fs.existsSync(path.join(home, '.cursor'))) {
    list.push({
      id: 'cursor',
      label: 'Cursor',
      reason:
        'Cursor records activity in a SQLite database of code edits, not token counts. Its usage figures live in the account dashboard.',
    });
  }
  if (fs.existsSync(path.join(home, '.copilot'))) {
    list.push({
      id: 'copilot',
      label: 'GitHub Copilot',
      reason: 'Copilot keeps no local usage log. Its quota is reported by the GitHub account API.',
    });
  }

  list.push({
    id: 'subscriptions',
    label: 'Plan limits and credits',
    reason:
      'Session caps, weekly limits and credit balances come from each provider’s billing API, which needs the account credentials. This daemon does not hold them and does not read the credential files those tools store.',
  });

  return list;
}

// ------------------------------------------------------------------- scan ---

export interface LocalUsageOptions {
  /** Where the index is kept. Normally beside the daemon database. */
  indexPath: string;
  /** How far back to look. */
  windowDays?: number;
  /** Overridden in tests. */
  home?: string;
  /** Ceiling on bytes read in one scan, so a first run cannot stall the API. */
  maxBytes?: number;
}

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_MAX_BYTES = 1_500_000_000;

export function collectLocalUsage(options: LocalUsageOptions): LocalUsageReport {
  const home = options.home ?? os.homedir();
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const cutoff = Date.now() - windowDays * 86_400_000;

  const index = readIndex(options.indexPath);
  const seen = new Set<string>();
  let bytesRead = 0;
  let truncated = false;

  const providers: ProviderUsage[] = [];

  for (const spec of providerSpecs(home)) {
    if (!fs.existsSync(spec.root)) continue;

    const files = sessionFiles(spec.root, cutoff);
    const provider: ProviderUsage = {
      id: spec.id,
      label: spec.label,
      root: spec.root,
      sessionCount: 0,
      days: [],
      totals: emptyTotals(),
      models: {},
      firstSeen: null,
      lastSeen: null,
    };

    const byDay: Record<string, Record<string, TokenTotals>> = {};

    for (const { file, stat } of files) {
      seen.add(file);
      let entry = index.files[file];

      const unchanged = entry && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs;
      if (!unchanged) {
        // A file that shrank was replaced rather than appended to, so the old
        // offset means nothing and it is read from the start.
        const grew = entry && stat.size > entry.size;
        if (!entry || !grew) {
          entry = { offset: 0, size: 0, mtimeMs: 0, model: null, days: {} };
        }

        if (bytesRead >= maxBytes) {
          truncated = true;
        } else {
          const current = entry;
          const { offset, bytesRead: read } = readNewLines(file, current.offset, (line) =>
            spec.handler(line, current)
          );
          current.offset = offset;
          current.size = stat.size;
          current.mtimeMs = stat.mtimeMs;
          bytesRead += read;
          index.files[file] = current;
          entry = current;
        }
      }

      if (!entry) continue;

      let contributed = false;
      for (const [date, models] of Object.entries(entry.days)) {
        if (date < localDate(cutoff)) continue;
        const day = (byDay[date] ??= {});
        for (const [model, tokens] of Object.entries(models)) {
          addTotals((day[model] ??= emptyTotals()), tokens);
          contributed = true;
        }
      }
      if (contributed) {
        provider.sessionCount += 1;
        const at = stat.mtimeMs;
        provider.lastSeen = provider.lastSeen === null ? at : Math.max(provider.lastSeen, at);
        provider.firstSeen = provider.firstSeen === null ? at : Math.min(provider.firstSeen, at);
      }
    }

    provider.days = Object.entries(byDay)
      .map(([date, models]) => {
        const totals = emptyTotals();
        for (const tokens of Object.values(models)) addTotals(totals, tokens);
        return { date, models, totals };
      })
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    for (const day of provider.days) {
      addTotals(provider.totals, day.totals);
      for (const [model, tokens] of Object.entries(day.models)) {
        addTotals((provider.models[model] ??= emptyTotals()), tokens);
      }
    }

    if (provider.totals.total > 0) providers.push(provider);
  }

  // Drop files that fell out of the window or were deleted, so the index does
  // not grow without bound.
  for (const file of Object.keys(index.files)) {
    if (!seen.has(file)) delete index.files[file];
  }
  writeIndex(options.indexPath, index);

  return {
    providers,
    unavailable: unavailableProviders(home),
    windowDays,
    scannedAt: Date.now(),
    bytesRead,
    truncated,
  };
}
