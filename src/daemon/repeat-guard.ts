import { createHash } from 'node:crypto';

/**
 * Stable JSON stringification with alphabetically sorted keys.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k])).join(',') + '}';
}

export interface RepeatGuardResult {
  count: number;
  note?: string;
}

/**
 * Detects and prevents models from repeating identical actions in a loop
 * when no workspace changes have occurred.
 */
export class RepeatGuard {
  private readonly callCounts = new Map<string, number>();

  /**
   * Generates a stable key for a tool call given its name, arguments, and workspace revision.
   */
  hashKey(tool: string, args: Record<string, unknown>, workspaceRevision: number): string {
    const raw = `${tool}:${stableStringify(args)}:${workspaceRevision}`;
    return createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Records a tool call and returns advisory notes at thresholds 3 and 5,
   * or throws an error at threshold 8.
   */
  record(tool: string, args: Record<string, unknown>, workspaceRevision: number): RepeatGuardResult {
    const key = this.hashKey(tool, args, workspaceRevision);
    const count = (this.callCounts.get(key) ?? 0) + 1;
    this.callCounts.set(key, count);

    if (count >= 8) {
      throw new Error(
        `Stopped: Identical action "${tool}" called 8 times without workspace change. Try a different approach or report a blocker.`
      );
    }

    let note: string | undefined;
    if (count === 3 || count === 5) {
      note = `Identical action "${tool}" called ${count} times without workspace changes. If progress has stalled, try a different approach or report a blocker.`;
    }

    return note !== undefined ? { count, note } : { count };
  }

  /**
   * Get the current count for a given tool call.
   */
  getCount(tool: string, args: Record<string, unknown>, workspaceRevision: number): number {
    const key = this.hashKey(tool, args, workspaceRevision);
    return this.callCounts.get(key) ?? 0;
  }
}
