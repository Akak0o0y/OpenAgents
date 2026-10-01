# Privacy and security

OpenAgents keeps runtime state on the machine running it, but **local does not mean offline**. Chosen model providers receive the prompts/context sent to them; web/browser tasks contact sites; configured MCP tools can access external systems. Review those providers' terms and your tool permissions before using confidential data.

## What is stored

| Data | Typical location / handling |
| --- | --- |
| Bots, conversations, tasks, routines, memory, events and results | SQLite database; standalone default `data/openhours.db`. |
| Local API token and database identity | Sibling `<database>.auth.json`; private to the local installation. |
| Provider keys saved through settings | Encrypted for the current Windows user with DPAPI. Other production OS backends are not yet implemented. |
| Source-run provider keys | Your process environment / `.env` sources; never source-controlled. |
| Browser accounts and cookies | Per-profile managed browser state; treat as credentials. Persistence support varies by platform. |
| Desktop settings, logs, backups and window state | Electron user-data directory. Packaged Windows preserves `%APPDATA%\OpenHours` for compatibility. |
| Task workspaces and bot desktops | Managed Docker resources and local task/output storage. Completion does not imply automatic deletion. |
| Local usage dashboard | Reads supported coding-tool session logs on this machine to derive token/usage totals; the index is private and excluded from source publication. |

Source-run profiles can differ from installed profiles. An explicit `OPENAGENTS_DATA_DIR` can isolate an Electron development session. Never move a real profile into a repository to reproduce a bug.

## Boundaries and limitations

The daemon binds loopback and authenticates API/WebSocket use. Keep it private; do not forward its port to the internet. A bearer token is access, not a public project identifier. MCP server processes run on the host with configured access. Docker socket access and browser account sessions are powerful capabilities. Approvals and isolation reduce risk but are not a guarantee that a model or tool cannot make a mistake.

Review before approving external posting, repository publication, or actions involving private files/accounts. Preserve fail-closed handling for expired approval, wrong account, changed scope, uncertain costs, and missing result evidence.

## What was excluded from this public source snapshot

This publication uses a clean snapshot on top of the existing public repository. It does not import the owner's private development Git history. The public tree excludes personal `.env` files and fleet configurations, local databases/auth sidecars, profile/browser state, local usage indexes, raw logs, private planning notes, development scratch files, and third-party research captures. Demo screenshots and video use synthetic conversation data. Tests contain intentionally fake identities and credentials where needed.

The publication review includes staged-file inventory, personal-identifier checks, and secret scanning. Scanning reduces risk but is not a mathematical proof that no sensitive content can exist. Continue reviewing every contribution and generated artifact before publishing it. Third-party author credits and legally required notices are retained; they are not an owner's private profile data.

## Share diagnostics safely

Report the OS, Node version, app version/commit, steps, expected behavior, actual behavior, and a minimal redacted error. Remove API keys, bearer tokens, cookie values, private URLs, email addresses, usernames, full local paths, prompts, and business content from logs/screenshots. Never upload a whole profile or database to an issue.

If a real credential is exposed, revoke/rotate it at its provider; removing a file from a later commit does not revoke access or erase earlier history. See [SECURITY.md](../SECURITY.md) for reporting a vulnerability.

## Backups and removal

Close the relevant runtime before handling its database files. Keep backups private; they can contain the same sensitive data as the live profile. Uninstalling the desktop app is designed to preserve user data. Use the app's scoped cleanup controls and inspect their preview; do not indiscriminately delete unrelated Docker containers or browser profiles. This source publication does not erase the owner's local working data.
