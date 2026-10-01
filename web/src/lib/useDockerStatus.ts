/**
 * Docker's status, for the banner that explains why a task that runs code
 * cannot start.
 *
 * The daemon's monitor is the source of truth (GET /api/docker), so this works
 * in a plain browser too. In the desktop app "Start Docker" goes through the
 * shell, which can launch Docker Desktop; a browser can only check again.
 *
 * Polled often while Docker is down - that is when someone is fixing it - and
 * rarely while it is up. A daemon that does not monitor Docker (older builds,
 * tests) answers 501, and then there is simply no banner.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from './transport.js';
import { desktopBridge, type DockerStatus } from './desktop.js';

export const DOCKER_DOWNLOAD_URL = 'https://www.docker.com/products/docker-desktop/';
export const WSL_INSTALL_URL = 'https://learn.microsoft.com/windows/wsl/install';

export interface DockerSession {
  status: DockerStatus | null;
  busy: boolean;
  /** True when the desktop shell can launch Docker Desktop. */
  canStart: boolean;
  start: () => void;
  refresh: () => void;
}

export function useDockerStatus(enabled: boolean): DockerSession {
  const [status, setStatus] = useState<DockerStatus | null>(null);
  const [installed, setInstalled] = useState(false);
  const [shellStatus, setShellStatus] = useState<DockerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      let next = 60_000;
      try {
        const body = await api.docker();
        if (cancelled) return;
        setStatus(body.docker);
        next = body.docker && body.docker.state !== 'running' ? 10_000 : 60_000;
      } catch {
        // Not monitored, or the daemon is away: no banner, and ask rarely.
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), next);
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled, nonce]);

  useEffect(() => {
    const docker = desktopBridge()?.docker;
    if (!docker) return;
    let cancelled = false;
    const take = (value: DockerStatus | null) => {
      if (!cancelled && value) { setInstalled(Boolean(value.installed)); setShellStatus(value); }
    };
    void docker.status().then(take);
    const off = docker.onStatus(take);
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const refresh = useCallback(() => {
    setBusy(true);
    void api
      .dockerRefresh()
      .then((body) => setStatus(body.docker))
      .catch(() => undefined)
      .finally(() => setBusy(false));
  }, []);

  const start = useCallback(() => {
    const docker = desktopBridge()?.docker;
    if (!docker) {
      refresh();
      return;
    }
    setBusy(true);
    void docker
      .start()
      .then((value) => { setShellStatus(value); return api.dockerRefresh(); })
      .then((body) => setStatus(body.docker))
      .catch(() => undefined)
      .finally(() => {
        setBusy(false);
        setNonce((n) => n + 1);
      });
  }, [refresh]);

  // Keep setup progress authoritative while the daemon still sees a missing
  // engine. A successful daemon probe can clear a stale setup failure.
  const setup = shellStatus && ['preparing', 'downloading', 'installing', 'starting', 'setup-paused', 'setup-failed', 'setup-blocked', 'restart-required'].includes(shellStatus.state);
  const effective = status?.state === 'running' ? status : setup ? shellStatus : status ?? shellStatus;
  return { status: effective, busy, canStart: Boolean(desktopBridge()?.docker) && (installed || Boolean(shellStatus?.canSetup)), start, refresh };
}

/**
 * The sidebar banner for Docker, or null when there is nothing to say.
 *
 * Short on purpose - the sidebar is narrow. The full sentence, naming the
 * exact fix, is the tooltip.
 */
export function dockerBanner(docker: DockerSession): {
  message: string;
  hint: string;
  actionLabel: string;
  busyLabel: string;
  onRetry: () => void;
  retrying: boolean;
} | null {
  const status = docker.status;
  if (!status || status.state === 'running') return null;
  const base = { hint: status.message, retrying: docker.busy };
  if (status.canSetup) {
    const working = ['preparing', 'downloading', 'installing', 'starting'].includes(status.state);
    const reboot = status.state === 'restart-required';
    return { ...base, message: status.message, actionLabel: reboot ? 'Restart Windows, then reopen' : 'Retry setup', busyLabel: reboot ? 'Waiting for restart' : 'Setting up…', retrying: working || reboot || docker.busy, onRetry: docker.start };
  }
  switch (status.state) {
    case 'stopped':
      return docker.canStart
        ? { ...base, message: "Docker isn't running", actionLabel: 'Start Docker', busyLabel: 'Starting…', onRetry: docker.start }
        : { ...base, message: "Docker isn't running", actionLabel: 'Check again', busyLabel: 'Checking…', onRetry: docker.refresh };
    case 'not-installed':
      return docker.canStart
        ? { ...base, message: "Docker isn't reachable", actionLabel: 'Start Docker', busyLabel: 'Starting…', onRetry: docker.start }
        : { ...base, message: "Docker isn't installed", actionLabel: 'Get Docker', busyLabel: 'Checking…', onRetry: () => window.open(DOCKER_DOWNLOAD_URL, '_blank', 'noopener') };
    case 'wsl-missing':
      return { ...base, message: "WSL isn't set up for Docker", actionLabel: 'How to fix', busyLabel: 'Checking…', onRetry: () => window.open(WSL_INSTALL_URL, '_blank', 'noopener') };
    default:
      return { ...base, message: "Docker didn't answer", actionLabel: 'Check again', busyLabel: 'Checking…', onRetry: docker.refresh };
  }
}
