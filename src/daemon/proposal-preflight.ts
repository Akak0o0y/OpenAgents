/**
 * Proposal pre-flight.
 *
 * The goal producer invents tasks by asking a model for a test file and an
 * implementation stub. It validated the JSON shape but never checked that the
 * test it wrote could actually RUN, and the failure mode was observed live:
 *
 *     import { describe, it, assert } from 'node:test';
 *                          ^^^^^^ node:test has no such export
 *
 * The test could not load, so no agent could ever pass it. It compounds with
 * the anti-tamper mechanism - protected test files are restored before grading,
 * so even an agent that correctly diagnosed the broken import would have its
 * fix reverted. A malformed proposal is not a wasted task, it is a task that is
 * UNPASSABLE BY CONSTRUCTION, and it burns a daily proposal slot every time.
 *
 * The fix: stage the proposal and run its test command ONCE before accepting.
 * Three outcomes matter, and only one of them is a good proposal:
 *
 *   UNLOADABLE      the test cannot even be parsed or imported  -> reject
 *   ALREADY_PASSING the test passes against the stub            -> reject
 *   USABLE          the test loads and fails on an assertion    -> ACCEPT
 *
 * That middle case is easy to miss: a proposal whose tests already pass gives
 * the agent nothing to do, and would be scored as an instant win.
 */

import { DockerSandbox } from '../kernel/docker-sandbox.js';
import type { ProposalSpec } from './goal-producer.js';

export type PreflightVerdict = 'USABLE' | 'UNLOADABLE' | 'ALREADY_PASSING' | 'INCONCLUSIVE';

export interface PreflightResult {
  verdict: PreflightVerdict;
  reason: string;
  exitCode?: number;
  /** First ~400 chars of combined output, for the rejection record. */
  output?: string;
}

/**
 * Signatures of a module that never loaded.
 *
 * These are the primary signal, NOT the test count. `node --test` runs each
 * file in a subprocess and reports a file that fails to load as ONE FAILING
 * TEST - observed directly: a syntax error in a test file produced
 * `tests 1 / pass 0 / fail 1`, indistinguishable by count from a genuine
 * assertion failure.
 */
const LOAD_FAILURE_SIGNATURES = [
  'SyntaxError',
  'ERR_MODULE_NOT_FOUND',
  'ERR_UNKNOWN_FILE_EXTENSION',
  'ERR_UNSUPPORTED_DIR_IMPORT',
  'ERR_REQUIRE_ESM',
  'Cannot find module',
  'Cannot find package',
  'does not provide an export named',
  'Unexpected token',
  'Unexpected identifier',
] as const;

/**
 * Classify a pre-flight run. Pure, so the rules are testable without Docker.
 *
 * The bias is deliberate and asymmetric: a false REJECT costs one proposal
 * slot, while a false ACCEPT costs an entire agent run that cannot possibly
 * succeed, plus every retry of it. So anything unrecognised is rejected.
 */
export function classifyPreflight(run: {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}): PreflightResult {
  const output = `${run.stderr}\n${run.stdout}`.trim();
  const preview = output.slice(0, 400);

  if (run.timedOut) {
    return {
      verdict: 'INCONCLUSIVE',
      reason: 'The proposed test command timed out during pre-flight, so it could not be verified.',
      exitCode: run.exitCode,
      output: preview,
    };
  }

  const signature = LOAD_FAILURE_SIGNATURES.find((s) => output.includes(s));
  if (signature) {
    return {
      verdict: 'UNLOADABLE',
      reason:
        `The proposed test cannot load ("${signature}"), so no agent could ever pass it. ` +
        `This is the failure the pre-flight exists to catch.`,
      exitCode: run.exitCode,
      output: preview,
    };
  }

  if (run.exitCode === 0) {
    return {
      verdict: 'ALREADY_PASSING',
      reason:
        'The proposed test already passes against its own starting files, so the task is complete ' +
        'before an agent touches it and would score as a free win.',
      exitCode: run.exitCode,
      output: preview,
    };
  }

  if (!/ERR_ASSERTION|AssertionError/.test(output)) {
    return { verdict: 'INCONCLUSIVE', reason: 'The command failed without evidence of a test assertion failure.', exitCode: run.exitCode, output: preview };
  }
  return {
    verdict: 'USABLE',
    reason: 'The test loads and fails, which is exactly what a fresh task should do.',
    exitCode: run.exitCode,
    output: preview,
  };
}

/**
 * Stage a proposal in a throwaway workspace and run its test command once.
 *
 * Runs in the same hardened profile as any other executor task: no network, no
 * secrets, all capabilities dropped. The volume is always destroyed, including
 * when the sandbox itself throws.
 */
export async function runPreflight(
  sandbox: DockerSandbox,
  spec: ProposalSpec,
  options: { timeoutMs?: number } = {}
): Promise<PreflightResult> {
  let volume: string | null = null;
  try {
    volume = await sandbox.createWorkspaceVolume(`preflight-${Date.now()}-${spec.name}`);
    await sandbox.stageWorkspaceFiles(volume, spec.files);
    const res = await sandbox.executeTask(volume, spec.testCommand, {
      timeoutMs: options.timeoutMs ?? 90_000,
    });
    return classifyPreflight(res);
  } catch (err: any) {
    // Infrastructure failure is INCONCLUSIVE, never a pass. If the sandbox
    // cannot run the test now, the agent could not run it either.
    return {
      verdict: 'INCONCLUSIVE',
      reason: `Pre-flight could not run: ${err?.message ?? err}`,
    };
  } finally {
    if (volume) await sandbox.destroyWorkspaceVolume(volume).catch(() => undefined);
  }
}
