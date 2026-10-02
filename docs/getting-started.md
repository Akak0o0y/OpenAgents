# Getting started

This guide covers a fresh **source checkout**. Do not copy someone else's database, browser profile, `.env`, or API keys. The repository contains templates and synthetic test fixtures, not an owner's working profile.

**Just want to try the app on Windows?** Follow the [download and first-run guide](try-windows.md). The packaged preview includes its runtime, so the Git/Node/npm build steps below are unnecessary for that path. Provider and Docker requirements still apply to the features that use them.

## 1. Choose your setup

| Platform | Recommended approach | Qualification limits |
| --- | --- | --- |
| Windows | Run Node/npm and Electron in Windows; use Docker Desktop in Linux-container mode. | Main desktop development target; unsigned builds and remaining release gaps are documented. |
| Linux | Run Node/npm natively; use Docker Engine or an appropriate Docker Desktop installation. | Runtime development path; saved provider credentials currently lack a production Linux keyring backend. |
| macOS | Run Node/npm natively; use Docker Desktop or another verified compatible Docker engine. | Runtime development path; packaged app/notarization and saved credentials need further qualification. |
| WSL Linux development | Keep Node/npm, checkout, dependencies, and Docker CLI in the same Linux environment. | Browser/runtime development is distinct from building and running the Windows Electron shell. |

Do not share `node_modules` between Windows and WSL/Linux. Native dependencies are platform-specific. For WSL development, a checkout in the distro's Linux filesystem is usually simpler than mixing Windows paths and Linux tooling.

## 2. Install prerequisites

Install Git and a compatible Node.js release from their official distributions. The root package requires Node **>=22.13.0** because it uses `node:sqlite`; Node 24 is the recommended baseline. Check:

```bash
git --version
node --version
npm --version
```

Install Docker if you need isolated tasks or a bot desktop. Docker must run **Linux containers**. Docker Desktop is a separate product with its own [subscription terms and Windows requirements](https://docs.docker.com/desktop/setup/install/windows-install/).

### Windows and WSL 2

WSL means Windows Subsystem for Linux. Docker Desktop can use WSL 2 to run Linux containers while OpenAgents itself runs as a normal Windows app. You do not need a second computer or a dual-boot Linux installation.

1. Enable hardware virtualization in firmware if it is disabled.
2. Follow [Microsoft's WSL installation guide](https://learn.microsoft.com/en-us/windows/wsl/install) and Docker's current requirements. Installation/feature enablement may need administrator access and a restart.
3. Install/start Docker Desktop, select its WSL 2 backend and Linux containers, and wait for its engine to become ready.
4. In the terminal used for OpenAgents, run `docker version` and `docker info`. Both client and server must be reachable.

If you choose a user-managed Ubuntu distro, Microsoft's usual starting command is `wsl --install`; complete its first-run setup and check `wsl --list --verbose`. Use the vendor documentation for your Windows edition. A custom Ubuntu distro is **optional** for the default OpenAgents transport: current Windows code discovers Docker Desktop's native `docker.exe`.

If you deliberately run Docker inside a specific distro, set `OPENAGENTS_WSL_DISTRO` to its exact installed name. Make sure `wsl -d <distro> --exec docker info` works first. Do not set this variable merely because Docker Desktop uses WSL internally.

### Linux and macOS

Follow [Docker Engine installation](https://docs.docker.com/engine/install/) on Linux or [Docker Desktop installation](https://docs.docker.com/desktop/) for your OS. The current user must be able to run `docker info`. Access to a Docker socket is powerful host access; do not expose it to untrusted clients. WSL is a Windows feature and is not required on native Linux/macOS.

## 3. Clone and install

```bash
git clone https://github.com/Akak0o0y/OpenAgents.git
cd OpenAgents
npm ci
npm --prefix web ci
npm --prefix desktop ci
npm run build
npm run web:build
npm --prefix desktop run icon
```

The desktop install/icon steps are optional for browser-only runtime development. Three package directories have independent lockfiles. Run `npm ci` in each required directory; do not install dependencies globally to compensate for a missing local install.

For standalone browser-adapter development and browser tests:

```bash
npm run browser:install
```

On Linux CI or a minimal Linux machine, browser OS libraries may also be required:

```bash
npx playwright install --with-deps chromium
```

That command can require elevated OS package installation. The pinned Playwright package determines the browser version; a system Chrome install alone does not satisfy every test.

## 4. Configure your own bots and provider

Copy `.env.example` to `.env` and `openhours.config.example.json` to `openhours.config.json`. Use `Copy-Item` in PowerShell or `cp` on Linux/macOS. Never overwrite an existing personal file without reviewing it.

The legacy configuration filenames are intentional compatibility identifiers. The app's current name is OpenAgents. The example has two bots, no standing mission, no MCP servers, no repository grants, and a disabled example routine. **Its model ID is an example, not a promise of free inference.**

Follow [provider setup](providers.md). With the built-in executor, the interface can start before a provider is configured; a real task needs a valid connection/key and usable model. An explicitly configured OpenCode executor or standing mission can require credentials at startup.

## 5. Launch

For the built desktop UI, run `npm run desktop`. It starts the Electron shell and supervised daemon. For browser-only use, run `npm run daemon` and open `http://127.0.0.1:4001`. The daemon creates a local SQLite database and a sibling authentication file. Use that token only with your own loopback connection page.

If Docker is unavailable, the UI can still explain setup state, but Docker-dependent work cannot complete. The current app always uses a bot-owned Docker desktop and regular Chrome for daemon browser work; there is no host-browser fallback. Bot Chrome needs an x64 Linux Docker engine. Installing Playwright Chromium supports standalone browser adapters and tests and does not replace that desktop setup. See [configuration](configuration.md).

Start with one small task using synthetic or public information. Inspect its activity, questions, and result. Enable recurring work only after its provider and tools work. The runtime must stay running for schedules; the desktop tray behavior is configurable.

## 6. Update safely

Keep your changes on a branch. Review release notes and commits, then fetch/pull normally; do not use a hard reset to update a dirty checkout. Re-run the relevant `npm ci` commands after lockfile changes and rebuild. Back up local profiles before testing migrations. An uninstall does not intentionally erase the installed profile.

For clean reproduction, use a new source checkout and a disposable profile. [Development](development.md) describes explicit ports, data directories, tests, and packaging. A compiled source build is not proof of a clean-machine installer or cross-platform release.
