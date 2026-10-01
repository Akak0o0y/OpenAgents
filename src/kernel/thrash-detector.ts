/**
 * Intra-Task Thrash & Stagnation Detector
 * Analyzes compiler/runtime stderr fingerprints and workspace diffs
 * to catch agents stuck in loops before they burn money.
 */

import { createHash } from 'node:crypto';
import type { ThrashState, TurnRecord } from './types.js';

export class ThrashDetector {
  private history: TurnRecord[] = [];
  private readonly maxDuplicateErrors: number;
  private readonly maxStagnantTurns: number;

  constructor(maxDuplicateErrors = 3, maxStagnantTurns = 3) {
    this.maxDuplicateErrors = maxDuplicateErrors;
    this.maxStagnantTurns = maxStagnantTurns;
  }

  /**
   * Normalize stderr to produce a stable error fingerprint.
   * Strips:
   * - Line and column numbers (e.g. at line 42:15)
   * - Timestamps (e.g. 2026-09-04 14:22:10)
   * - Memory addresses and hex pointers (e.g. 0x7ffd8a9b)
   * - Ephemeral process IDs and temp directory paths
   */
  normalizeError(rawStderr: string): string | null {
    if (!rawStderr || rawStderr.trim().length === 0) {
      return null;
    }

    const cleaned = rawStderr
      // Strip line/col numbers
      .replace(/:\d+(:\d+)?/g, ':LINE')
      // Strip memory addresses
      .replace(/0x[0-9a-fA-F]+/g, '0xHEX')
      // Strip ISO timestamps and dates
      .replace(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(\.\d+)?/g, 'TIMESTAMP')
      // Strip ephemeral temp paths
      .replace(/\/tmp\/[a-zA-Z0-9_-]+/g, '/tmp/TMPFILE')
      .replace(/[A-Z]:\\.*\\AppData\\Local\\Temp\\[a-zA-Z0-9_-]+/g, 'TEMPFILE')
      // Strip test durations and timings
      .replace(/duration_ms:\s*[\d.]+/gi, 'duration_ms:TIME')
      // Normalize whitespace
      .replace(/\s+/g, ' ')
      .trim();

    return createHash('sha256').update(cleaned).digest('hex').substring(0, 16);
  }

  /**
   * Compute a hash of current workspace files to detect mutation stagnation.
   */
  computeWorkspaceHash(files: Record<string, string>): string {
    const sortedKeys = Object.keys(files).sort();
    const hash = createHash('sha256');
    for (const key of sortedKeys) {
      hash.update(key);
      hash.update(files[key]);
    }
    return hash.digest('hex').substring(0, 16);
  }

  /**
   * Record a turn and evaluate whether the agent is thrashing.
   */
  recordTurn(
    turnNumber: number,
    rawStderr: string,
    workspaceFiles: Record<string, string>
  ): ThrashState {
    const errorFingerprint = this.normalizeError(rawStderr);
    const workspaceDiffHash = this.computeWorkspaceHash(workspaceFiles);

    const record: TurnRecord = {
      turnNumber,
      errorFingerprint,
      workspaceDiffHash,
      timestamp: Date.now(),
    };

    this.history.push(record);

    let consecutiveDuplicateErrors = 0;
    let consecutiveZeroDiffTurns = 0;

    // Check recent history backwards
    if (errorFingerprint && this.history.length >= 2) {
      for (let i = this.history.length - 1; i >= 0; i--) {
        if (this.history[i].errorFingerprint === errorFingerprint) {
          consecutiveDuplicateErrors++;
        } else {
          break;
        }
      }
    }

    if (this.history.length >= 2) {
      for (let i = this.history.length - 1; i >= 1; i--) {
        if (this.history[i].workspaceDiffHash === this.history[i - 1].workspaceDiffHash) {
          consecutiveZeroDiffTurns++;
        } else {
          break;
        }
      }
    }

    const isDuplicateErrorThrash = consecutiveDuplicateErrors >= this.maxDuplicateErrors;
    const isStagnationThrash = consecutiveZeroDiffTurns >= this.maxStagnantTurns;
    const isThrashing = isDuplicateErrorThrash || isStagnationThrash;

    let reason: string | undefined;
    if (isDuplicateErrorThrash) {
      reason = `Repeated identical error fingerprint (${errorFingerprint}) across ${consecutiveDuplicateErrors} consecutive turns.`;
    } else if (isStagnationThrash) {
      reason = `Workspace mutation stagnation: ${consecutiveZeroDiffTurns} consecutive turns with zero file changes.`;
    }

    return {
      consecutiveDuplicateErrors,
      consecutiveZeroDiffTurns,
      lastFingerprint: errorFingerprint,
      lastDiffHash: workspaceDiffHash,
      isThrashing,
      reason,
    };
  }

  getTurnCount(): number {
    return this.history.length;
  }

  reset() {
    this.history = [];
  }
}
