/**
 * The Docker banner names the fix that applies, and says nothing when there is
 * nothing to fix. Its button must do what it says: start Docker only where the
 * desktop app can, and otherwise check again or link to the missing install.
 */

import { describe, expect, it, vi } from 'vitest';
import { dockerBanner, DOCKER_DOWNLOAD_URL, WSL_INSTALL_URL, type DockerSession } from './useDockerStatus.js';
import type { DockerStatus } from './desktop.js';

const status = (state: DockerStatus['state'], message = `Docker is ${state}.`): DockerStatus => ({
  state,
  message,
  version: null,
  detail: null,
  via: 'wsl.exe -d Ubuntu-22.04 docker',
  checkedAt: 1,
});

const session = (value: DockerStatus | null, canStart = false): DockerSession => ({
  status: value,
  busy: false,
  canStart,
  start: vi.fn(),
  refresh: vi.fn(),
});

describe('dockerBanner', () => {
  it('keeps automatic setup progress and required actions visible', () => {
    const setup = session({ ...status('downloading', 'Downloading Docker Desktop… 45%'), canSetup: true }, true);
    expect(dockerBanner(setup)?.message).toContain('45%');
    expect(dockerBanner(setup)?.retrying).toBe(true);
    const failed = session({ ...status('setup-failed', 'Download failed. Retry setup.'), canSetup: true }, true);
    dockerBanner(failed)!.onRetry();
    expect(failed.start).toHaveBeenCalledOnce();
    expect(dockerBanner(failed)?.actionLabel).toBe('Retry setup');
    const reboot = session({ ...status('restart-required', 'Save your work and restart Windows.'), canSetup: true }, true);
    expect(dockerBanner(reboot)?.message).toContain('restart Windows');
    expect(dockerBanner(reboot)?.busyLabel).toBe('Waiting for restart');
  });
  it('stays quiet before the first check and while Docker runs', () => {
    expect(dockerBanner(session(null))).toBeNull();
    expect(dockerBanner(session(status('running')))).toBeNull();
  });

  it('offers to start Docker Desktop only where the desktop app can', () => {
    const desktop = session(status('stopped'), true);
    const startable = dockerBanner(desktop)!;
    expect(startable.actionLabel).toBe('Start Docker');
    startable.onRetry();
    expect(desktop.start).toHaveBeenCalledTimes(1);

    const browser = session(status('stopped'));
    const checkOnly = dockerBanner(browser)!;
    expect(checkOnly.actionLabel).toBe('Check again');
    checkOnly.onRetry();
    expect(browser.refresh).toHaveBeenCalledTimes(1);
    expect(browser.start).not.toHaveBeenCalled();
  });

  it('links to what is missing and keeps the full sentence as the hint', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    try {
      const missing = dockerBanner(session(status('not-installed', 'Docker is not installed. Chat works without it.')))!;
      expect(missing.message).toBe("Docker isn't installed");
      expect(missing.hint).toBe('Docker is not installed. Chat works without it.');
      missing.onRetry();
      expect(open).toHaveBeenCalledWith(DOCKER_DOWNLOAD_URL, '_blank', 'noopener');

      dockerBanner(session(status('wsl-missing')))!.onRetry();
      expect(open).toHaveBeenCalledWith(WSL_INSTALL_URL, '_blank', 'noopener');
    } finally {
      open.mockRestore();
    }
  });

  it('shows the busy label while a start or check is in flight', () => {
    const banner = dockerBanner({ ...session(status('unknown')), busy: true })!;
    expect(banner.retrying).toBe(true);
    expect(banner.busyLabel).toBe('Checking…');
  });
});
