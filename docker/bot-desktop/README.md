# Bot-owned desktop foundation

This image contains XFCE and Google's regular `google-chrome-stable` package, installed through its signed official Debian repository. It contains no Chrome for Testing binary and does not use the person's Windows Chrome.

Required runtime contract:

- One container and persistent home volume per OpenAgents profile plus bot ID. Never mount the user's home, browser profile, Docker socket, or another bot's volume.
- Non-root user, bounded memory/processes, private shared-memory segment, and loopback-only viewer publication.
- Read-only service files at `/run/secrets/desktop-password`, `/run/secrets/desktop-token`, and `/run/secrets/egress.mjs`. VNC, noVNC and Chrome CDP bind to container loopback. Only the bearer-authenticated gateway on port 6090 is published on host loopback. The daemon authenticates the human viewer separately and never gives its gateway bearer to the browser UI.
- Chrome's own sandbox stays enabled. If the Docker/kernel security profile prevents its namespace sandbox from starting, report that failure. Do not add `--no-sandbox`, `--privileged`, `SYS_ADMIN`, or globally disable host protections.
- Only stop a bot's container on shutdown; retain its volume. Deleting a bot's environment requires an explicit data-deletion action.

Build from the repository with `docker build -t openhours-bot-desktop:development docker/bot-desktop`. The package version installed at build time is recorded in `/etc/openhours-chrome-version`; final releases need an explicit image/version update policy.

Opt-in source integration is available with `OPENHOURS_BOT_DESKTOP=1`, using `BotDesktop` and the existing browser action adapter. It is not an installed-app migration or a production release. The image must already exist; automatic image provisioning, shell-tool integration, crash recovery, general Linux-process egress policy, explicit deletion/backup, and real account acceptance remain release gates. No personal-browser fallback is used in this mode. Do not claim ordinary Chrome guarantees acceptance by X or Google.

## Sandbox profile provenance

`seccomp.json` is derived from [Microsoft Playwright v1.63.0's Docker profile](https://github.com/microsoft/playwright/blob/v1.63.0/utils/docker/seccomp_profile.json), copyright Microsoft Corporation, under Apache-2.0 (included in `LICENSE.seccomp`). It retains a default-deny syscall policy and permits the user-namespace calls needed by Chrome. Local changes return ENOSYS for `clone3` so modern glibc uses `clone`, and allow Chrome's `chroot` syscall inside its user namespace. Kernel capability checks still apply; the outer container has all capabilities dropped. This profile does not install or run Playwright or Chrome for Testing in the desktop image.

Run `node scripts/verify-bot-desktop.mjs` after building, with the appropriate Docker transport selected. It creates two uniquely labelled test desktops, checks real Chrome windows and profile isolation/restart, and deletes only its own labelled containers and disposable test volumes.
