# Configuration reference

Configuration is per installation/profile. **Keep real configuration private:** it can contain names, goals, local paths, repository grants, MCP environment values, or other sensitive context even if the main provider keys live elsewhere. Only `openhours.config.example.json` is a publication template.

The authoritative schema is [`src/daemon/config-file.ts`](../src/daemon/config-file.ts). The on-disk filename keeps its pre-rename identifier for compatibility. Settings with the new prefix are aliased to compatible internal names by `src/kernel/env-alias.ts`; use the new prefix for daemon/desktop settings unless a development tool explicitly documents otherwise.

## Example fleet

Start from the committed template rather than from another person's profile. It is valid JSON: comments are not allowed. Restart/reload using the relevant app flow after changing settings; do not edit a database directly.

| Field | Meaning |
| --- | --- |
| `agents[].id` | Stable kebab-case identifier. References from routines and permissions must match. |
| `name`, `role` | Display name and role used in bot behavior. |
| `systemPrompt` | Optional full override; when supplied it replaces the role-derived prompt. |
| `model` | Provider/model identifier or a saved gateway's exact wire identifier. Check current availability. |
| `connection` | Optional ID of a saved provider connection. It is not an API key. |
| `routing` | Optional `pinned` or `auto`, used with a connection. Gateway substitution behavior still matters. |
| `fallbackModel` | Explicit fallback preference; do not assume arbitrary automatic model switching. |
| `budgetUsd` | Positive per-agent budget setting; free/unknown/paid usage still needs provider accounting. |
| `requiresApproval` | Require operator approval before task dispatch. It is not a substitute for external-action grants. |
| `mcpServers` | Allowed configured MCP server names. Empty/omitted denies MCP tools. |
| `delegateTo` | Other bot IDs this bot may delegate to; empty denies cross-bot delegation. |
| `obsidianVault` | Optional local vault path. Treat it as private filesystem access. |

## Routines, goals, and work

Routines name an `agentId`, `schedule`, `timezone`, `prompt`, optional `taskName`, `enabled`, and `catchUpPolicy` (`skip` or `run_once`). The example routine is disabled. Use an IANA timezone and verify the next run displayed in the UI. A machine that is asleep or a stopped daemon cannot execute a schedule normally.

An optional `mission` enables standing-goal decomposition and can introduce ongoing work and provider usage. It is absent by default. `scheduler.cadenceMs` and `scheduler.maxConcurrency` govern scheduling; keep concurrency small while validating your setup.

Custom task contracts live under `contracts`; use [the example](examples/custom-task-contract.json) and the schema in `src/daemon/work-contract.ts`. Goals, character memory, approved identity, and inferred claims have separate state; changing an avatar is not a grant to perform external actions.

## Browser and repositories

`browser.enabled` controls managed browser availability; `browser.maxConcurrency` is bounded from 1 to 4. `browser.isolation` accepts:

- `auto`: prefer a Docker sandbox when available, otherwise use the computer browser path.
- `sandbox`: require the Docker-backed browser path.
- `computer`: choose the host-managed browser path.

`repositories.local` maps aliases to approved local paths. `repositories.github` contains repository names, a `tokenEnv` variable name, and an explicit `publish` flag (default false). Use only repositories you may access. A token variable name is configuration; the actual token stays out of Git. Publication rights should be scoped and reviewed.

`visionModels` is an explicit allowlist after verifying image-input support for those exact model IDs. Do not enable it merely because a model has a visual-sounding name.

## MCP tools

Top-level `mcpServers` declares the process command, arguments, explicit environment, call quota, optional tool allowlist, and connection timeout. These are **real host subprocesses**, not code inside the task sandbox. Install trusted servers and grant individual bots only what they need. Do not place live credentials in a public configuration example.

## Common environment variables

| Variable | Purpose |
| --- | --- |
| `OPENAGENTS_DB_PATH` | Daemon SQLite database path. |
| `OPENAGENTS_CONFIG` | Explicit fleet JSON path; `none` ignores local fleet files. |
| `OPENAGENTS_ENV_FILE` | Absolute path to an existing credential env file; additional default env sources are still checked. |
| `OPENAGENTS_PORT` | Daemon port, default 4001 for standalone development. |
| `OPENAGENTS_DATA_DIR` | Absolute Electron profile override for separate desktop test profiles. |
| `OPENAGENTS_DOCKER_CMD` | Explicit Docker-compatible executable; bypasses WSL transport/path rewriting. Compatibility is your responsibility. |
| `OPENAGENTS_WSL_DISTRO` | Opt into Docker through the named Windows WSL distro. Not needed for normal Docker Desktop native CLI use. |
| `OPENAGENTS_EXECUTOR` | `builtin` or `opencode`. |
| `OPENAGENTS_LLM_MODE=mock` | Explicit synthetic test mode; never proof of real inference. |
| `OPENAGENTS_MISSION` | Standing goal override; can cause recurring work/provider use. |

Many advanced bounds are in `src/daemon/config.ts`. Values named `PROVISIONAL_*` are estimates, not calibrated safety guarantees. Preserve fail-closed behavior and add tests when changing runtime limits.
