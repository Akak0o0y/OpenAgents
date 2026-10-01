/**
 * A bot's "computer".
 *
 * In OpenAgents a bot's computer is the container workspace its current run
 * owns. That is a real thing with a real lifecycle, and this hook reports that
 * lifecycle honestly rather than animating a desktop that does not exist:
 *
 *   idle        no run has ever been dispatched for this bot
 *   connecting  a run is queued; nothing is executing yet
 *   starting    a run is executing but its workspace has not answered yet
 *   connected   the workspace answered with a file listing
 *   unreachable the daemon said why it could not reach it (Docker down, volume
 *               reaped after the run finished, and so on)
 *
 * `unreachable` is the state behind the "Can't reach your computer" banner. It
 * carries the daemon's own reason, because "reaped when the run COMPLETED" and
 * "Docker is not running" need very different responses from the operator.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type TaskRunRow } from './transport.js';

export type ComputerState = 'idle' | 'connecting' | 'starting' | 'connected' | 'unreachable' | 'not-required';

export interface ComputerSession {
  state: ComputerState;
  files: string[];
  reason: string | null;
  runId: string | null;
  retrying: boolean;
  retry: () => void;
}

export function useComputerSession(
  agentId: string | null,
  latestRun: TaskRunRow | null
): ComputerSession {
  const [state, setState] = useState<ComputerState>('idle');
  const [files, setFiles] = useState<string[]>([]);
  const [reason, setReason] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [nonce, setNonce] = useState(0);
  /** Which agent the in-flight probe belongs to. */
  const probeFor = useRef<string | null>(null);

  const runId = latestRun?.id ?? null;
  const runStatus = latestRun?.status ?? null;

  useEffect(() => {
    if (!agentId || !runId) {
      if (retrying) {
        setState('starting');
        const timer = setTimeout(() => {
          setState('idle');
          setRetrying(false);
          setReason(null);
        }, 600);
        return () => clearTimeout(timer);
      }
      setState('idle');
      setFiles([]);
      setReason(null);
      return;
    }
    if (runStatus === 'QUEUED') {
      setState('connecting');
      setFiles([]);
      setReason(null);
      return;
    }
    // Browser sign-in sessions never own a code workspace. Older daemons
    // report a missing volume for these runs, which is not a Docker outage.
    if (latestRun?.task_name === 'browser-login') {
      setState('not-required');
      setFiles([]);
      setReason(null);
      setRetrying(false);
      return;
    }

    let cancelled = false;
    probeFor.current = agentId;
    setState('starting');

    void (async () => {
      try {
        const result = await api.workspace(runId);
        if (cancelled || probeFor.current !== agentId) return;
        if (!result.available) {
          setFiles([]);
          setReason(result.reason);
          setState(result.required === false ? 'not-required' : 'unreachable');
          return;
        }
        setFiles(result.files);
        setReason(null);
        setState('connected');
      } catch (cause) {
        if (cancelled || probeFor.current !== agentId) return;
        setFiles([]);
        setReason(cause instanceof Error ? cause.message : 'The workspace could not be reached.');
        setState('unreachable');
      } finally {
        if (!cancelled) setRetrying(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [agentId, runId, runStatus, latestRun?.task_name, nonce]);

  const retry = useCallback(() => {
    setRetrying(true);
    setNonce((value) => value + 1);
  }, []);

  return { state, files, reason, runId, retrying, retry };
}

/** One line describing the state, used by both the preview and the overlay. */
export function computerStatusLabel(state: ComputerState, agentName?: string): string {
  switch (state) {
    case 'idle':
      return agentName ? `${agentName} is ready` : 'Desktop ready';
    case 'not-required':
      return 'Desktop ready';
    case 'connecting':
      return 'Connecting';
    case 'starting':
      return 'Starting desktop';
    case 'connected':
      return 'Connected';
    case 'unreachable':
      return agentName ? `Can't reach ${agentName}'s screen` : "Can't reach your computer";
    default:
      return agentName ? `${agentName} is ready` : 'Desktop ready';
  }
}
