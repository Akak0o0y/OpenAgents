/**
 * Keeping the local usage scan off the request path.
 *
 * The first scan reads every session log this machine has written inside the
 * window - on a working developer's machine that is hundreds of megabytes and
 * takes seconds. Every scan after it reads only the bytes that were appended,
 * and takes milliseconds. Those two facts want opposite handling, so:
 *
 *   - A request is answered from the last completed scan, immediately, always.
 *   - The expensive first scan runs once at boot, in the background. Until it
 *     finishes the answer is `null`, which the interface renders as "still
 *     reading" rather than as zero.
 *   - A stale cache refreshes in the background on the next request, and that
 *     request still returns the previous figures rather than waiting.
 *
 * A number that is a minute old is worth far more here than a settings screen
 * that hangs.
 */

import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { collectLocalUsage, type LocalUsageReport } from './local-usage.js';

const STALE_AFTER_MS = 60_000;

export interface LocalUsageCacheOptions {
  /** Directory to keep the incremental index in - normally beside the database. */
  stateDir: string;
  windowDays?: number;
  /** Overridden in tests. */
  home?: string;
  onLog?: (message: string) => void;
}

export class LocalUsageCache {
  private report: LocalUsageReport | null = null;
  private scanning = false;
  private readonly indexPath: string;

  constructor(private readonly options: LocalUsageCacheOptions) {
    this.indexPath = path.join(options.stateDir, 'local-usage-index.json');
  }

  /**
   * The most recent completed scan, or null if there has not been one yet.
   *
   * Never blocks. Triggers a refresh when the figures have gone stale, and
   * returns the old ones while that runs.
   */
  current(): LocalUsageReport | null {
    if (!this.report || Date.now() - this.report.scannedAt > STALE_AFTER_MS) {
      this.refresh();
    }
    return this.report;
  }

  /**
   * Start a scan unless one is already running.
   *
   * ON A WORKER THREAD. This used to run on the daemon's own thread after a
   * `setImmediate`, on the reasoning that the scan is I/O rather than CPU work.
   * But it is SYNCHRONOUS I/O, and a first scan of hundreds of megabytes held
   * the event loop for over six seconds after boot: chat replies, approvals and
   * the interface's live updates all waited behind it. A worker blocks only
   * itself. Where a worker cannot start, the old in-process scan still runs.
   */
  refresh(): void {
    if (this.scanning) return;
    this.scanning = true;
    const started = Date.now();
    const options = { indexPath: this.indexPath, windowDays: this.options.windowDays, home: this.options.home };
    let settled = false;
    const finish = (report: LocalUsageReport | null, error?: string) => {
      if (settled) return;
      settled = true;
      this.scanning = false;
      if (error || !report) {
        this.options.onLog?.(`Local usage scan failed: ${error ?? 'no report'}`);
        return;
      }
      this.report = report;
      // Only worth a line when it actually did work; the warm case is noise.
      if (report.bytesRead > 0) {
        const mb = (report.bytesRead / 1e6).toFixed(1);
        this.options.onLog?.(`Local usage scan: ${report.providers.length} provider(s), ${mb} MB read in ${Date.now() - started}ms`);
      }
    };

    let worker: Worker;
    try {
      worker = new Worker(new URL('./local-usage-worker.js', import.meta.url), { workerData: options });
    } catch {
      setImmediate(() => {
        try { finish(collectLocalUsage(options)); } catch (cause: any) { finish(null, String(cause?.message ?? cause)); }
      });
      return;
    }
    worker.once('message', (message: { ok: boolean; report?: LocalUsageReport; error?: string }) =>
      message.ok ? finish(message.report ?? null) : finish(null, message.error));
    worker.once('error', (cause) => finish(null, cause.message));
    worker.once('exit', (code) => finish(null, `the scan stopped unexpectedly (exit ${code})`));
    // A scan in flight must not keep a stopping daemon alive.
    worker.unref();
  }

  /** Resolves when no scan is running. For tests and shutdown. */
  async idle(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.scanning && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
