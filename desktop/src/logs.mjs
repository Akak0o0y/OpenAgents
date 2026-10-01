/**
 * The log file, and the diagnostics a person can paste into a bug report.
 *
 * Before this the daemon's output lived in a 500-line ring buffer in memory.
 * The moment the app closed - which is the moment someone is trying to report
 * what went wrong - it was gone. Now it is also written to
 * `<userData>/logs/openhours.log`, rotated so it cannot grow without bound.
 *
 * REDACTION HAPPENS ON THE WAY IN. A log file is the thing people attach to a
 * public issue without reading it first, so a provider key or the daemon's
 * session token must never reach the file, not merely be hidden when shown.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PATTERNS = [
  // Authorization headers and bearer tokens.
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, '$1 [redacted]'],
  // Provider key shapes: OpenAI/OpenRouter/Anthropic style, Google.
  [/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, 'AIza[redacted]'],
  // key=value and "key": "value" for anything named like a secret.
  [/\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|openhours_session)["']?\s*[:=]\s*["']?)[^\s"'&,;}]{6,}/gi, '$1[redacted]'],
  // The daemon's session token is 64 hex characters.
  [/\b[a-f0-9]{64}\b/gi, '[redacted-hex]'],
];

/** Remove secrets and the user's home path from one line of text. */
export function redact(text, { secrets = [], home = os.homedir() } = {}) {
  let out = String(text);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  if (home && home.length > 3) {
    // Both slash directions: paths are logged by Node and by Windows tools.
    for (const form of new Set([home, home.replace(/\\/g, '/')])) out = out.split(form).join('~');
  }
  return out;
}

/**
 * An append-only log with size-based rotation.
 *
 * Writes are batched and flushed synchronously on a short timer. A write
 * stream would be faster, but rotating a file a stream still holds open fails
 * on Windows, and a chatty daemon is not chatty enough to need it.
 */
export class LogFile {
  constructor(dir, { name = 'openhours.log', maxBytes = 5 * 1024 * 1024, keep = 3, flushMs = 500, secrets = () => [] } = {}) {
    this.dir = dir;
    this.file = path.join(dir, name);
    this.maxBytes = maxBytes;
    this.keep = keep;
    this.flushMs = flushMs;
    this.secrets = secrets;
    this.pending = [];
    this.timer = null;
    this.disabled = false;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      this.disabled = true;
    }
  }

  write(line, source = 'shell') {
    if (this.disabled) return;
    const text = redact(String(line).replace(/\s+$/, ''), { secrets: this.secrets() });
    this.pending.push(`${new Date().toISOString()} [${source}] ${text}\n`);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushMs);
      this.timer.unref?.();
    }
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.disabled || this.pending.length === 0) return;
    const chunk = this.pending.join('');
    this.pending = [];
    try {
      let size = 0;
      try { size = fs.statSync(this.file).size; } catch { /* first write */ }
      if (size > 0 && size + Buffer.byteLength(chunk) > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, chunk);
    } catch {
      // A disk that refuses the log must not take the app down with it.
    }
  }

  /** openhours.log -> openhours.1.log -> ... ; the oldest beyond `keep` is removed. */
  rotate() {
    const { dir } = this;
    const ext = path.extname(this.file);
    const base = path.basename(this.file, ext);
    const numbered = (n) => path.join(dir, `${base}.${n}${ext}`);
    try { fs.rmSync(numbered(this.keep), { force: true }); } catch { /* ignore */ }
    for (let n = this.keep - 1; n >= 1; n--) {
      try { if (fs.existsSync(numbered(n))) fs.renameSync(numbered(n), numbered(n + 1)); } catch { /* ignore */ }
    }
    try { fs.renameSync(this.file, numbered(1)); } catch { /* ignore */ }
  }

  close() {
    this.flush();
  }
}

/**
 * A plain-text report for "Copy diagnostics".
 *
 * Everything a maintainer asks for first, nothing they should not see: the
 * whole report goes through the same redaction as the log.
 */
export function diagnosticsReport(facts, { secrets = [] } = {}) {
  const lines = [
    'OpenAgents diagnostics',
    `Generated: ${new Date().toISOString()}`,
    '',
    `App version: ${facts.appVersion}${facts.packaged ? '' : ' (running from source)'}${facts.portable ? ' (portable)' : ''}`,
    `Electron ${facts.versions?.electron} / Chromium ${facts.versions?.chrome} / Node ${facts.versions?.node}`,
    `System: ${facts.platform} ${facts.osVersion} ${facts.arch}`,
    `Data folder: ${facts.dataDir}`,
    '',
    `Server: ${facts.daemon?.status ?? 'unknown'}${facts.daemon?.detail ? ` - ${facts.daemon.detail}` : ''}`,
    `Server port: ${facts.daemon?.port ?? 'unknown'} (${facts.daemon?.owned ? 'started by this app' : 'not started by this app'})`,
    `Restarts this session: ${facts.daemon?.restarts ?? 0}`,
    `Docker: ${facts.docker ? `${facts.docker.state} - ${facts.docker.message}` : 'not checked yet'}`,
    ...(facts.docker?.via ? [`Docker reached through: ${facts.docker.via}`] : []),
    `Settings: ${JSON.stringify(facts.settings ?? {})}`,
    '',
    `Last ${facts.log?.length ?? 0} log lines:`,
    ...(facts.log ?? []),
  ];
  return lines.map((line) => redact(line, { secrets })).join('\n');
}
