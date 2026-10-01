/**
 * The local usage scan, on its own thread.
 *
 * The scan reads other coding tools' session logs with synchronous file I/O -
 * hundreds of megabytes on a working machine. Run on the daemon's thread it
 * froze everything for seconds after boot: chat replies, approvals, the
 * interface's live updates. Here it blocks only this worker.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { collectLocalUsage, type LocalUsageOptions } from './local-usage.js';

try {
  parentPort?.postMessage({ ok: true, report: collectLocalUsage(workerData as LocalUsageOptions) });
} catch (error) {
  parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
