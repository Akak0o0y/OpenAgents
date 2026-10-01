# Troubleshooting

Begin with your OS, Node version, app version/commit, the exact command, and the first useful error. Redact keys, tokens, personal paths, and conversation content before sharing diagnostics.

| Symptom | Checks and next step |
| --- | --- |
| `node:sqlite` missing or startup crashes on an old Node | Use Node >=22.13; Node 24 is the development baseline. Reinstall native dependencies for that runtime/platform with the lockfile. |
| Cannot find a package / TypeScript or Vite command missing | Run `npm ci` in the correct package: root, `web`, and optional `desktop`. Do not reuse Windows `node_modules` from WSL. |
| Docker client works but server does not | Run `docker info` in the same terminal. Start the intended engine and confirm Linux-container mode. A CLI install alone is not an engine. |
| WSL distro not found | Check `wsl --list --verbose`; correct/remove an explicit `OPENAGENTS_WSL_DISTRO`. Default Windows Docker Desktop use does not need that override. |
| Permission denied on Docker socket on Linux | Follow Docker's documented user-access setup. Do not make the socket world-writable or expose it remotely. |
| Browser executable/library missing | Run `npm run browser:install`; on Linux install the pinned browser's OS dependencies as documented. |
| Browser page returns 401 | Use the token for the **active database's** `.auth.json`, not another profile. Do not disable auth. Check Vite proxy target/auth-file overrides in development. |
| Database/profile is already in use | Stop the runtime that owns it or select a different profile. Do not delete a live lock or start concurrent writers. |
| Port already used / UI connects to wrong daemon | Inspect the active runtime's port; set an explicit development port/profile and update the Vite proxy. Avoid mixing standalone and shell daemons accidentally. |
| Provider settings cannot store a key on Linux/macOS | Protected storage is not yet implemented there. Use supported environment-based provider paths, or contribute a real OS backend. |
| FreeLLMAPI not found | Install its own dependencies, choose the correct compatible checkout, or point at an already running gateway. OpenAgents does not clone/install it automatically. |
| Gateway unreachable | Verify it is running and the URL is reachable from the daemon's environment. Loopback inside Docker/WSL can refer to a different machine context. |
| `401`/`403` from provider | Verify the gateway/client key and permissions. A gateway key is different from each upstream provider key. |
| `429`, exhausted quota, no usable models | Inspect provider/gateway quota and current catalog; wait or choose an allowed model. Do not assume every listed model is funded or free. |
| Saving provider did not change a bot | Select the saved connection/model in that bot's settings; saving alone intentionally does not switch bots. |
| Routine did not run | Verify enabled state, timezone, next run, provider readiness, approvals, concurrency, and that the runtime was awake/running. |
| Model claimed a post/file/action happened but no receipt exists | Inspect recorded actions and durable results. Report the discrepancy; model prose alone is not proof. |
| Windows package build reports `EBUSY`/`EPERM` | Close the old unpacked app and any process holding the output folder. Review antivirus activity. Retry the build after the actual lock resolves. |
| Packaged app does not match source UI | Rebuild both backend and `web`, regenerate icons, and verify the package's build/version identity. Old source directories are not proof of packaged contents. |

The current frontend build can warn about a large output chunk. That is a performance concern to improve, not a secret build failure. npm deprecation/audit messages should be investigated separately from whether installation succeeded.

If a problem persists, create a minimal reproduction using a disposable profile and fake/public content. Include which tests actually ran and which prerequisites were missing. For exploitable security defects, follow [private reporting guidance](../SECURITY.md) instead of posting credentials or an active exploit in a public issue.
