# Try OpenAgents on Windows

Download the **0.6.3 Windows x64 preview** from [GitHub Releases](https://github.com/Akak0o0y/OpenAgents/releases/tag/v0.6.3-preview.1). You do not need to build the source or install Node/npm to open the packaged app.

| Download | Use it for |
| --- | --- |
| [Portable app](https://github.com/Akak0o0y/OpenAgents/releases/download/v0.6.3-preview.1/OpenAgents-0.6.3-portable.exe) | A quick trial: download and double-click. It extracts the runtime before opening. |
| [Windows installer](https://github.com/Akak0o0y/OpenAgents/releases/download/v0.6.3-preview.1/OpenAgents-0.6.3-setup.exe) | A regular per-user installation, shortcuts, and an uninstaller. |
| [SHA-256 checksums](https://github.com/Akak0o0y/OpenAgents/releases/download/v0.6.3-preview.1/SHA256SUMS.txt) | Check that your download matches the published file. |

These are **unsigned preview builds**, with known runtime bugs. Windows may display an unknown-publisher or SmartScreen warning. Download only from this project's release page and verify the checksum if needed. The build is for Windows x64; no macOS, Linux, or native Windows ARM installer is included in this release.

## First run

1. Download the portable app or installer above. You do not need both. The automatic GitHub “Source code” ZIP is for developers; it is not the executable app.
2. Open the app. For the installer, finish its setup wizard and launch OpenAgents. The portable app extracts roughly 554 MB of files on each launch; extraction took about 90 seconds on the release-check machine. Give it time, and use the installer if you prefer to avoid repeated extraction.
3. Configure your own model provider in Settings and select a usable model for your bot. No personal accounts, API keys, or model credits are included. Follow [provider setup](providers.md), including the extra steps for a separately installed FreeLLMAPI gateway.
4. For isolated coding or the bot desktop, install/start Docker Desktop with **Linux containers**. Its WSL 2 backend needs virtualization and Windows features; a separate Linux computer or a manually installed Ubuntu distro is not required. See [Windows/WSL setup](getting-started.md#windows-and-wsl-2).
5. Start with one small task. Review its activity and result before enabling routines. Chat/provider tasks need a working model connection; Docker-dependent tasks also need their sandbox ready.

The app can open its interface before provider or Docker setup is complete. That does not make real model calls or sandbox tasks work without those dependencies. The app's setup controls may request a Docker/WSL installation or elevation; review those prompts. Managed-browser features may also need a Chromium download through setup.

## What is included

The Electron desktop shell, its Node runtime, the built interface and daemon, production libraries, original project artwork, third-party notices, and a starter configuration are bundled. Docker, model services/credits, a configured FreeLLMAPI checkout, and personal browser accounts are separate.

OpenAgents is free of charge. Thank you to [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) and all contributing developers. Provider quotas and costs still apply. Project-authored code is MIT licensed; bundled Aora engine/data retain their separate non-commercial terms. Read [licensing and credits](licensing-and-credits.md).

## Your data and closing the app

Both installer and portable builds normally use `%APPDATA%\OpenHours` for compatibility. “Portable” means no installation step, **not** a profile stored beside the executable. An existing OpenHours/OpenAgents installation can share this profile; back it up before trying a preview. Uninstalling intentionally preserves it.

This version removes chat messages and cached chat requests after 24 hours, including overdue chat history when the runtime starts. It waits for an active chat request to finish. Routine runs, artifacts, activity evidence, and budgets follow separate retention rules. Existing profile backups are not rewritten.

Closing the window can leave the app running in the system tray so routines continue. Choose **Quit** from its tray menu to stop it. There is no configured automatic update feed in this preview; download a later release manually.

To check a downloaded file in PowerShell:

```powershell
Get-FileHash .\OpenAgents-0.6.3-portable.exe -Algorithm SHA256
```

Compare the result with `SHA256SUMS.txt` on the same release page.

## Preview limitations and feedback

The broad runtime/browser suites and current community CI are not green. Known failures include chat/task ownership, resource waiting, publication-result assertions, and CI dependency/platform setup. These binaries are for early feedback, not a claim of production qualification. See [validation](validation.md) and [known limitations](known-limitations.md).

[Report a bug](https://github.com/Akak0o0y/OpenAgents/issues/new/choose) with the app version, Windows version, steps, expected/actual result, and redacted diagnostics. Never attach your full profile, `.env`, auth tokens, API keys, or private conversations. Developers can build, customize, enhance, and fix the project using [CONTRIBUTING](../CONTRIBUTING.md).
