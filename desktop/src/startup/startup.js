/*
 * The startup screen's behaviour.
 *
 * Reads the shell's live state through the same preload bridge the real
 * interface uses. The shell replaces this page with the app the moment the
 * server answers, so everything here is about the time before that - and about
 * never leaving a person looking at a spinner with no way forward.
 */

(() => {
  const bridge = window.openhours;
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const startedAt = Date.now();
  let serverState = null;
  let dockerStatus = null;
  let elapsedTimer = null;

  const TITLES = {
    checking: 'Starting OpenAgents',
    starting: 'Starting OpenAgents',
    restarting: 'Restarting the server',
    running: 'Opening OpenAgents',
    attached: 'Opening OpenAgents',
    failed: "OpenAgents couldn't start",
    stopped: 'The server is stopped',
  };

  const LEDES = {
    checking: 'Getting your bots ready. This takes a few seconds the first time.',
    starting: 'Getting your bots ready. This takes a few seconds the first time.',
    restarting: 'It stopped unexpectedly, so OpenAgents is starting it again.',
    running: 'Everything is ready.',
    attached: 'Everything is ready.',
    failed: 'Nothing is lost. Try again, or copy the diagnostics if it keeps happening.',
    stopped: 'Start it again to continue.',
  };

  function setStep(id, state) {
    $(id).dataset.state = state;
  }

  function showToast(text) {
    const toast = $('toast');
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function renderElapsed() {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    const busy = serverState && ['checking', 'starting', 'restarting'].includes(serverState.status);
    $('elapsed').textContent = busy && seconds >= 3 ? `${seconds}s` : '';
  }

  function renderServer(state) {
    serverState = state;
    const status = state?.status ?? 'checking';
    stage.dataset.status = status;
    $('title').textContent = TITLES[status] ?? TITLES.checking;
    $('lede').textContent = LEDES[status] ?? LEDES.checking;

    const profileDone = status !== 'checking' || Boolean(state?.port);
    setStep('step-profile', status === 'failed' && !state?.port ? 'error' : profileDone ? 'done' : 'active');
    setStep('step-server',
      status === 'running' || status === 'attached' ? 'done'
        : status === 'failed' || status === 'stopped' ? 'error'
          : status === 'restarting' ? 'warn'
            : profileDone ? 'active' : 'waiting');

    const detail = $('detail');
    const showDetail = Boolean(state?.detail) && (status === 'failed' || status === 'restarting' || status === 'stopped');
    detail.hidden = !showDetail;
    detail.textContent = showDetail ? state.detail : '';
    $('failure-actions').hidden = !(status === 'failed' || status === 'stopped');
    renderElapsed();
  }

  function renderDocker(status) {
    dockerStatus = status;
    if (!status) return;
    const label = $('docker-label');
    const card = $('docker-card');
    if (status.state === 'running') {
      setStep('step-docker', 'done');
      label.textContent = status.version ? `Docker ${status.version} is running` : 'Docker is running';
      card.hidden = true;
      return;
    }
    if (['starting', 'preparing', 'downloading', 'installing'].includes(status.state)) {
      setStep('step-docker', 'active');
      label.textContent = status.message || 'Starting Docker Desktop…';
      card.hidden = true;
      return;
    }
    setStep('step-docker', 'warn');
    label.textContent = 'Docker is not available';
    card.hidden = false;
    $('docker-message').textContent = status.message;
    $('docker-start').hidden = !(status.canSetup || (status.installed && status.state !== 'wsl-missing'));
    $('docker-start').textContent = status.canSetup ? 'Retry setup' : 'Start Docker Desktop';
    $('docker-start').disabled = status.state === 'restart-required';
    $('docker-download').hidden = Boolean(status.canSetup || status.installed) || status.state === 'wsl-missing';
    $('wsl-help').hidden = Boolean(status.canSetup) || status.state !== 'wsl-missing';
  }

  if (!bridge) {
    renderServer({ status: 'failed', detail: 'This screen must be opened by the OpenAgents app.' });
    return;
  }

  void bridge.info().then((info) => {
    document.documentElement.dataset.theme = info.appTheme === 'dark' ? 'dark' : 'light';
    if (info.platform === 'darwin') document.body.classList.add('mac');
  });
  bridge.theme?.onAppearanceChange?.((theme) => {
    document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  });
  $('minimize').addEventListener('click', () => void bridge.window.minimize());
  $('close').addEventListener('click', () => void bridge.window.close());

  $('retry').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      renderServer(await bridge.daemon.restart());
    } finally {
      button.disabled = false;
    }
  });
  $('copy').addEventListener('click', async () => {
    try {
      await bridge.diagnostics.copy();
      showToast('Diagnostics copied. Keys and tokens were removed.');
    } catch {
      showToast('Could not copy the diagnostics.');
    }
  });
  $('logs').addEventListener('click', () => void bridge.diagnostics.openLogs());
  $('docker-start').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      renderDocker(await bridge.docker.start());
    } finally {
      button.disabled = false;
    }
  });

  void bridge.daemon.status().then(({ state }) => renderServer(state));
  bridge.daemon.onState(renderServer);
  void bridge.docker.status().then(renderDocker);
  bridge.docker.onStatus(renderDocker);
  elapsedTimer = setInterval(renderElapsed, 1000);
  window.addEventListener('beforeunload', () => clearInterval(elapsedTimer));
})();
