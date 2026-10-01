/** Windows first-run setup. No shell commands or installer URLs come from a renderer. */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDocker, findDockerDesktop, launchDockerDesktop } from './docker-desktop.mjs';
import { ensureWslDocker } from './wsl-docker.mjs';

export const DOCKER_INSTALLER_URL = 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe';
const PS = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const psQuote = value => `'${String(value).replaceAll("'", "''")}'`;

export function command(file, args, timeout = 120_000) {
  return new Promise(resolve => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? -1 : 0, stdout: String(stdout).replaceAll('\0', ''), stderr: String(stderr).replaceAll('\0', ''), error });
    });
  });
}
export function powershell(script, timeout) {
  // A shell launched from PowerShell 7 can inherit its incompatible module
  // search path. Load only the Windows modules used by this fixed helper.
  const isolated = `$env:PSModulePath=Join-Path $PSHOME 'Modules'; $ProgressPreference='SilentlyContinue'; ${script}`;
  return command(PS, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(isolated, 'utf16le').toString('base64')], timeout);
}

export async function windowsFacts() {
  const result = await powershell('$ErrorActionPreference="Stop"; $o=Get-CimInstance Win32_OperatingSystem; $c=Get-CimInstance Win32_ComputerSystem; $p=Get-CimInstance Win32_Processor | Select-Object -First 1; $v=Get-CimInstance Win32_OptionalFeature -Filter "Name = \'VirtualMachinePlatform\'"; @{build=[int]$o.BuildNumber;server=($o.ProductType -ne 1);ram=[double]$c.TotalPhysicalMemory;virtualization=($c.HypervisorPresent -or $p.VirtualizationFirmwareEnabled);vmpEnabled=($v.InstallState -eq 1);boot=$o.LastBootUpTime.ToUniversalTime().ToString("o")}|ConvertTo-Json -Compress', 30_000);
  if (result.code !== 0) throw new Error('Windows could not check this computer. Choose Retry setup; your chat is still available.');
  return JSON.parse(result.stdout.trim());
}
export function supportedWindows(facts, arch = process.arch) {
  if (arch !== 'x64' || facts.server || facts.build < 19045 || (facts.build >= 22000 && facts.build < 22631)) return 'This build needs a supported Windows 10/11 x64 computer. Chat is available; this computer cannot run the automatic sandbox setup.';
  if (facts.ram < 7.5 * 1024 ** 3) return 'The local sandbox needs at least 8 GB of memory. Chat is available on this computer.';
  if (!facts.virtualization) return 'Hardware virtualization is switched off. Enable virtualization in your computer’s firmware settings, then choose Retry setup. Windows cannot turn this on inside an app.';
  return null;
}
export function wslIsCurrent(result) {
  const match = result.stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  if (result.code !== 0 || !match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 5)));
}

/** Elevation is limited to Microsoft's WSL command and a read of feature states. */
export async function prepareWsl(current) {
  const inner = `$ErrorActionPreference='Stop'; $env:PSModulePath=Join-Path $PSHOME 'Modules'; $ProgressPreference='SilentlyContinue'; $reboot=$false; foreach($name in @('VirtualMachinePlatform','Microsoft-Windows-Subsystem-Linux')){ $feature=Get-WindowsOptionalFeature -Online -FeatureName $name; if($feature.State -eq 'EnablePending'){$reboot=$true}; if($feature.State -eq 'Disabled'){ $enabled=Enable-WindowsOptionalFeature -Online -FeatureName $name -All -NoRestart; if($enabled.RestartNeeded){$reboot=$true} } }; & "$env:SystemRoot\\System32\\wsl.exe" ${current.code === 0 ? '--update --web-download' : '--install --no-distribution --web-download --no-launch'}; $result=$LASTEXITCODE; if($reboot){exit 3010}; exit $result`;
  const encoded = Buffer.from(inner, 'utf16le').toString('base64');
  const result = await powershell(`try { $p=Start-Process -FilePath ${psQuote(PS)} -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'); exit $p.ExitCode } catch { if($_.Exception.NativeErrorCode -eq 1223){exit 1223}; Write-Error $_; exit 1 }`, 20 * 60_000);
  return result;
}

/** Bound redirects, hosts, duration and size; execute only after publisher validation. */
export async function downloadInstaller(directory, onProgress, fetcher = fetch) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'Docker-Desktop-Installer.exe');
  const partial = `${file}.partial`;
  let url = DOCKER_INSTALLER_URL;
  const signal = AbortSignal.timeout(20 * 60_000);
  let response;
  for (let redirects = 0; redirects <= 4; redirects++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'desktop.docker.com' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) throw new Error('Docker download redirected outside its trusted download service.');
    response = await fetcher(url, { redirect: 'manual', signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 4) throw new Error('Docker download redirected too many times.');
      url = new URL(location, url).href;
      continue;
    }
    break;
  }
  if (!response?.ok || !response.body) throw new Error(`Docker download failed (${response?.status ?? 'no response'}). Check your connection and choose Retry setup.`);
  const total = Number(response.headers.get('content-length')) || 0;
  const limit = 2 * 1024 ** 3;
  if (total > limit) { await response.body.cancel(); throw new Error('Docker installer exceeds the download limit.'); }
  let handle;
  try {
    handle = await fs.promises.open(partial, 'w');
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > limit) throw new Error('Docker installer exceeds the download limit.');
      await handle.writeFile(chunk);
      onProgress({ bytes, total });
    }
    if (bytes < 1024 || (total && bytes !== total)) throw new Error('Docker download was incomplete. Choose Retry setup.');
    await handle.close(); handle = null;
    await fs.promises.rename(partial, file);
    return file;
  } finally {
    await handle?.close();
    await fs.promises.rm(partial, { force: true });
  }
}
export async function verifyInstaller(file) {
  const result = await powershell(`$s=Get-AuthenticodeSignature -LiteralPath ${psQuote(file)}; @{status=$s.Status.ToString();subject=$s.SignerCertificate.Subject}|ConvertTo-Json -Compress`, 60_000);
  if (result.code !== 0) throw new Error('Windows could not verify the Docker installer. Nothing was installed.');
  let signature; try { signature = JSON.parse(result.stdout); } catch { /* rejected below */ }
  if (signature?.status !== 'Valid' || !/(?:^|,\s*)O="?Docker[ ,]+Inc\.?"?(?:,|$)/i.test(signature?.subject ?? '')) throw new Error('The Docker installer does not have a valid Docker publisher signature. Nothing was installed.');
}
export const installDocker = file => command(file, ['install', '--user', '--quiet', '--backend=wsl-2'], 20 * 60_000);

export class SandboxSetup {
  constructor({ directory, probe, onStatus, platform = process.platform, env = process.env, dependencies = {} }) {
    Object.assign(this, { directory, probe, onStatus, platform });
    this.explicitTransport = Boolean(env.OPENHOURS_DOCKER_CMD?.trim() || env.OPENHOURS_WSL_DISTRO?.trim());
    this.wslDistro = !env.OPENHOURS_DOCKER_CMD?.trim() ? env.OPENHOURS_WSL_DISTRO?.trim() : null;
    this.deps = { facts: windowsFacts, run: command, wsl: prepareWsl, download: downloadInstaller, verify: verifyInstaller, install: installDocker, find: findDockerDesktop, ensure: ensureDocker, ensureWsl: ensureWslDocker, launch: launchDockerDesktop, ...dependencies };
    this.stateFile = path.join(directory, 'sandbox-setup.json');
    try { this.saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { this.saved = {}; }
  }
  save(value) {
    this.saved = value;
    fs.mkdirSync(this.directory, { recursive: true });
    fs.writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(value));
    fs.renameSync(`${this.stateFile}.tmp`, this.stateFile);
  }
  report(state, message, extra = {}) {
    this.status = { state, message, version: null, detail: null, checkedAt: Date.now(), via: 'Docker Desktop', canSetup: this.platform === 'win32', ...extra };
    this.onStatus(this.status);
    return this.status;
  }
  run(options = {}) {
    if (!this.inflight) this.inflight = this.prepare(options).finally(() => { this.inflight = null; });
    return this.inflight;
  }
  async prepare({ automatic = true, retry = false } = {}) {
    try {
      const initial = await this.probe();
      if (initial.state === 'running') { this.save({}); return this.report('running', initial.message, initial); }
      if (!automatic && !retry) return this.report(initial.state, initial.message, initial);
      if (this.explicitTransport) {
        if (this.platform === 'win32' && this.wslDistro) {
          const local = await this.deps.ensureWsl({ distro: this.wslDistro, probe: this.probe,
            onStatus: status => this.report(status.state, status.message, status) });
          if (local) {
            if (local.state === 'running') this.save({});
            return this.report(local.state, local.message, local);
          }
        }
        // Upgraded profiles may intentionally keep their previous WSL engine
        // so its volumes are not stranded. That transport still benefits from
        // Docker Desktop being launched automatically; treating every custom
        // transport as untouchable forced the user to start it by hand.
        const executable = this.deps.find();
        if (executable) {
          this.report('starting', 'Starting the existing secure workspace…');
          const result = await this.deps.ensure({
            probe: this.probe,
            onStatus: status => this.report(status.state === 'running' ? 'running' : 'starting', status.state === 'running' ? status.message : 'Starting the existing secure workspace…', status.state === 'running' ? status : {}),
          });
          if (result.status.state === 'running') { this.save({}); return this.report('running', result.status.message, result.status); }
        }
        return this.report('setup-blocked', executable
          ? 'The saved Docker connection is not ready yet. OpenAgents will keep checking automatically; Docker Desktop may need its one-time terms or a Windows restart.'
          : 'The saved Docker connection is unavailable. OpenAgents will keep checking automatically. No local Docker service or Docker Desktop installation was found.');
      }
      if (this.platform !== 'win32') {
        const result = await this.deps.ensure({ probe: this.probe, onStatus: status => this.report(status.state, status.message, status) });
        return result.status;
      }
      const facts = await this.deps.facts();
      if (this.saved.state === 'restart-required' && this.saved.boot === facts.boot) return this.report(this.saved.state, this.saved.message);
      if (!retry && this.saved.state && this.saved.state !== 'restart-required') return this.report(this.saved.state, this.saved.message);
      const unsupported = supportedWindows(facts);
      if (unsupported) return this.block('setup-blocked', unsupported, facts.boot);
      if (this.deps.find()) {
        if (retry && this.saved.state === 'setup-paused') this.deps.launch(this.deps.find());
        this.report('starting', 'Starting the secure workspace…');
        const result = await this.deps.ensure({ probe: this.probe, onStatus: status => this.report(status.state, status.message, status) });
        if (result.status.state === 'running') { this.save({}); return this.report('running', result.status.message, result.status); }
      }
      this.report('preparing', 'Checking Windows components for the secure workspace…');
      const wsl = await this.deps.run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe'), ['--version'], 30_000);
      if (!wslIsCurrent(wsl) || facts.vmpEnabled === false) {
        this.save({ state: 'setup-paused', message: 'Windows setup was interrupted. Complete any open Windows prompt, then choose Retry setup.', boot: facts.boot });
        this.report('preparing', 'Preparing Windows components. Approve the Windows permission prompt to continue.');
        const result = await this.deps.wsl(wsl);
        if (result.code === 1223) return this.block('setup-paused', 'Windows permission was declined. Choose Retry setup when you are ready. Chat is available.', facts.boot);
        if (result.code === 3010 || result.code === 1641) return this.block('restart-required', 'Windows needs a restart to finish setup. Save your work and restart Windows, then open OpenAgents; setup will continue automatically.', facts.boot);
        if (result.code !== 0) throw new Error('Windows components could not be prepared. Check your connection and Windows updates, then choose Retry setup.');
        const ready = await this.deps.run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe'), ['--status'], 30_000);
        if (ready.code !== 0) return this.block('restart-required', 'Restart Windows to finish enabling the secure workspace, then open OpenAgents to continue automatically.', facts.boot);
      }
      if (!this.deps.find()) {
        this.report('downloading', 'Downloading Docker Desktop for the secure workspace…');
        let lastPercent = -1;
        const file = await this.deps.download(path.join(this.directory, 'setup-downloads'), progress => {
          const percent = progress.total ? Math.floor(progress.bytes / progress.total * 100) : Math.floor(progress.bytes / 1024 ** 2);
          if (percent !== lastPercent) { lastPercent = percent; this.report('downloading', `Downloading Docker Desktop… ${percent}${progress.total ? '%' : ' MB'}`); }
        });
        this.report('preparing', 'Verifying the Docker installer’s publisher…');
        await this.deps.verify(file);
        this.report('installing', 'Installing the secure workspace. This can take several minutes…');
        this.save({ state: 'setup-paused', message: 'Docker installation was interrupted. Complete any open installer, then choose Retry setup.', boot: facts.boot });
        const result = await this.deps.install(file);
        if ([3010, 1641].includes(result.code)) return this.block('restart-required', 'Save your work and restart Windows, then open OpenAgents; setup will continue automatically.', facts.boot);
        if ([1223, 1602].includes(result.code)) return this.block('setup-paused', 'Installation was cancelled. Choose Retry setup to continue. Chat is available.', facts.boot);
        if (result.code !== 0 || !this.deps.find()) throw new Error('Docker installation did not complete. Check free disk space and your connection, then choose Retry setup.');
      }
      // Docker owns its license acceptance UI. Never accept third-party terms
      // silently on a user's behalf, even when installing without a wizard.
      this.report('starting', 'Starting the secure workspace. If Docker opens its terms, review and accept them to continue.');
      const result = await this.deps.ensure({ probe: this.probe, onStatus: status => this.report(status.state === 'running' ? 'running' : 'starting', status.state === 'running' ? status.message : 'Preparing the secure workspace. Complete any Docker terms or Windows prompt that opens.', status.state === 'running' ? status : {}) });
      if (result.status.state === 'running') { this.save({}); return this.report('running', result.status.message, result.status); }
      return this.block('setup-paused', 'Docker needs attention. Open Docker Desktop to finish its terms or setup, then choose Retry setup. Chat is available.', facts.boot);
    } catch (error) {
      return this.block('setup-failed', error?.message ?? 'Setup could not finish. Choose Retry setup.', this.saved.boot);
    }
  }
  block(state, message, boot) { this.save({ state, message, boot }); return this.report(state, message); }
}
