# Development, tests, and packaging

Use a fork or feature branch, a disposable development profile, and your own credentials. Do not test migrations or browser actions against an important everyday profile. The repository has three independent dependency sets; follow [getting started](getting-started.md) first.

## Build and run

```bash
npm ci
npm --prefix web ci
npm --prefix desktop ci
npm run build
npm run web:build
npm --prefix desktop run icon
```

For a standalone daemon with UI hot reload, start `npm run daemon` in one terminal and `npm run web:dev` in another, then open `http://127.0.0.1:5173`. The Vite proxy targets port 4001 and uses the local daemon authentication file on the server side. The token is not compiled into the browser bundle.

For an Electron hot-reload session, run the Vite server and then `npm run desktop:dev`; the shell starts its daemon. Its profile/database can differ from the standalone root `data/` database. For this development tool, Vite's overrides are currently named `OPENHOURS_DAEMON` and `OPENHOURS_AUTH_FILE`. Point them at the shell's actual local URL/auth file when needed; these Vite settings are separate from the daemon's prefix-alias bootstrap.

Prefer explicit absolute `OPENAGENTS_DATA_DIR` for a throwaway desktop profile and a separate `OPENAGENTS_DB_PATH`/`OPENAGENTS_PORT` for a standalone daemon. Never run two daemons against one database. Keep local profile files outside tracked source.

## Test families

Build the backend before invoking scripts that run `dist/tests`. The root `npm test` is broader than a unit suite: it includes Docker-backed and browser integration work. Availability of Docker, OS/browser libraries, and explicit fixtures affects which checks can run.

| Command | Coverage / prerequisites |
| --- | --- |
| `npm run build` | Backend and test TypeScript compilation. |
| `npm run web:build` | Frontend type checking and Vite production bundle. |
| `npm --prefix web test` | React/Vitest component tests. |
| `npm run test:desktop` | Electron-shell lifecycle/configuration helpers and contracts. |
| `npm run test:daemon` | State, API, approvals, provider contracts, scheduling, memory and work behavior. Some tests exercise Docker when available. |
| `npm run test:browser` | Real pinned Chromium sessions and browser/research integration; install the browser first. |
| `npm run test:completion` | Attachments, documents, publication contract and work-question handling. |
| `npm run test:expansion` | Extended harness behavior. |
| `npm run test:kernel`, `npm run test:security` | Real Docker isolation/verdict and negative controls; running Linux-container engine required. |
| `npm run test:evals` | Evaluation trace infrastructure. |
| `npm run test:character-continuation` | Focused character/Off-parity regression group. |
| `npm run test:bot-desktop`, `npm run test:flow-desktop` | Live bot-desktop/flow verification; inspect scripts and use disposable local data. |
| `npm run release-gate` | Named build/test qualification matrix with a build identity and local evidence report. |

For a focused compiled backend test:

```bash
npm run build
node --test dist/tests/config-file.test.js
```

For a focused frontend file:

```bash
npm --prefix web test -- src/components/GrokRoutineEditor.test.tsx
```

Mock mode (`OPENAGENTS_LLM_MODE=mock`) is explicit test behavior, not a provider fallback or evidence of real inference. Do not run live-provider/evaluation/soak scripts casually: read their prerequisites and use your own controlled account/profile. Keep raw logs, screenshots, recordings, and reports private until reviewed. A green mocked test does not establish real external publication, a working paid account, or clean-machine packaging.

## CI

The workflow under `.github/workflows/` builds on Windows, Linux, and macOS using Node 24 and runs clearly named checks. It should use synthetic fixtures and no owner's credentials. Read the actual job results; the presence of a workflow file is not a passing CI run. Cross-platform issues and skipped prerequisites should be reported honestly.

## Windows packaging

```bash
npm run app:dir
# or build installer and portable targets
npm run app
```

These commands compile the root and web projects, generate the icon, and invoke electron-builder. Windows output belongs in `desktop/release/`, which is ignored. Keep generated executables out of source commits. The configured macOS/Linux targets require platform-specific work and validation; the current convenience scripts select Windows targets.

The shell uses Electron's Node runtime for the daemon. The package deliberately preserves the repository-relative runtime layout and uses `asar: false` for native/ESM compatibility. Docker/browser setup is separate from bundling Node. No signing certificate is supplied; an unsigned build is not a signed production release.

`npm run publish` names a **local delivery-folder workflow** (`scripts/publish-app.mjs`), not `git push` or npm registry publication. It checks qualification evidence and assembles local artifacts. Inspect its destination and options before use. Do not include private profiles, `.env`, signing keys, or update-channel secrets in a release.

## Useful development conventions

Keep protocol and UI types aligned. Prefer regression tests at the boundary where a failure occurred. Preserve cancellation, budget accounting, concurrency, expired approvals, and truthful terminal states. Use the existing local-authority and versioned-schema contracts rather than duplicating them in a component. Keep user-facing error messages actionable and redact secrets from diagnostics.

Native dependency installation can need platform build tools if a prebuilt binary is unavailable. Do not disable installation checks or run unknown repair scripts blindly. Dependency deprecation/audit findings and frontend bundle size are contribution opportunities; treat upgrades as separate verified changes.
