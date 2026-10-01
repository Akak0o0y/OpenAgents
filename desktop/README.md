# OpenAgents desktop shell

Electron hosts the React interface and supervises the Node daemon. A packaged app includes its Node runtime; source builds need Node/npm. Docker Linux containers and managed Chromium are separate prerequisites for the features that use them. A separately supervised FreeLLMAPI checkout needs its own compatible Node installation.

From the repository root:

```bash
npm ci
npm --prefix web ci
npm --prefix desktop ci
npm run app:dir
# or installer and portable targets
npm run app
```

Outputs are ignored under `desktop/release/`. Windows is the current convenience-script target; macOS/Linux packaging needs separate platform qualification. No signing certificate is included.

The package uses `asar: false` and keeps the daemon/interface relative paths intact for native/ESM compatibility. The daemon runs using Electron in Node mode. The normal app launcher clears that mode before starting the window.

Installed Windows profiles remain under `%APPDATA%\OpenHours` for compatibility. Source runs use their development profile unless explicitly overridden by an absolute `OPENAGENTS_DATA_DIR`. Database/auth files, settings, logs, browser sessions, and backups are private. Uninstalling does not intentionally delete user data.

Update behavior lives in `src/updates.mjs`; a maintainer must configure and validate a signed update channel before advertising a release feed. See [development and packaging](../docs/development.md), [setup](../docs/getting-started.md), and [privacy](../docs/privacy-and-security.md).
