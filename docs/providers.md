# Providers, FreeLLMAPI, and the meaning of free

**Thank you to [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi), its maintainers, and its contributors.** It provides an optional way to put supported provider free tiers behind an OpenAI-compatible endpoint. It is a separate project, not a hosted service or free account supplied with OpenAgents. Follow its [installation guide](https://github.com/tashfeenahmed/freellmapi/blob/main/docs/en/install/01-install.md) and current terms.

OpenAgents itself has no app subscription. A provider can still require an account/API key, limit requests or tokens, charge for a selected model, or change availability. FreeLLMAPI also has its own optional offerings. Do not treat an aggregate advertised free-token total as a quota guaranteed to you. No accounts, credentials, credit pools, or billing bypasses are included here.

## Connect FreeLLMAPI on Windows

1. Install and configure your own FreeLLMAPI instance using its upstream documentation.
2. Add the upstream provider keys you are authorized to use. Choose models eligible for your intended use and budget.
3. Create/copy the gateway's client API key through its UI. This is the key for OpenAgents; do not paste every upstream provider key into chat.
4. In OpenAgents, open **Settings → Providers**, add the **FreeLLMAPI** preset, and enter its reachable base URL, normally `http://127.0.0.1:3001/v1` for the local default.
5. Save the gateway API key and set sensible request/token admission limits.
6. Use **Test connection** and **Refresh models**. A reachable model list does not prove a paid or free generation has succeeded.
7. Open the bot's model settings and select that connection/model. **Saving a connection does not switch existing bots.**
8. Run a small task, inspect the served-model/result information, and check actual usage in the gateway/provider dashboard.

The local gateway panel can locate or accept a FreeLLMAPI source folder and supervise its Node process. It expects a compatible `@freellmapi/monorepo` checkout with dependencies already installed, and uses either its compiled server or its local `tsx` entry. It does not clone/install FreeLLMAPI for you. The gateway needs a standalone compatible Node installation even when OpenAgents is packaged with Electron's runtime. Use the upstream Node requirements too.

If the gateway is on another machine, use its actual reachable URL and secure transport. `127.0.0.1` always refers to the machine/environment making the request. A Windows host, WSL distro, and Docker container do not necessarily share the same loopback address.

## Saved credentials and platform support

Production provider-key storage currently uses **Windows DPAPI for the current Windows user**. The UI does not return saved plaintext keys. Linux/macOS deliberately report protected storage unavailable; the in-memory test store is not a production substitute.

On Linux/macOS, use the supported direct-provider environment paths for development, or contribute a real protected storage backend before promising gateway-settings parity. Do not patch in plaintext storage as a workaround. See `src/daemon/secret-store.ts`.

## Direct providers

`.env.example` names the supported credential variables, including `OPENROUTER_API_KEY`, `OPENCODE_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `GEMINI_API_KEY`. Different runtime/evaluation/executor paths use different providers; setting a variable does not make every model work everywhere.

For the built-in default path, choose a currently available OpenRouter model and set your own `OPENROUTER_API_KEY`. The sample/default model is not explicitly free. The OpenCode executor is a separate container-backed path; build its image with `npm run opencode:build-image` and consult the executor's model/credential configuration. Standing-goal decomposition has its own configured model and credential requirements.

Provider variables can come from the process environment or local env files. The loader checks an explicitly named `OPENAGENTS_ENV_FILE`, the current working directory's `.env`, and the user's home `.env`, without overriding an already populated variable. Review your environment when you want a clean or offline run; do not assume a new checkout alone removes inherited credentials.

## Routing and budgets

The bot config can select a saved `connection` and its model's wire ID. Routing modes distinguish a requested pinned model from an explicitly routed pool. FreeLLMAPI can substitute models according to its own routing behavior, so OpenAgents does not advertise its concrete requests as exact-model guarantees.

Per-bot USD budgets and request/token admission limits are controls inside OpenAgents. They are not an invoice, a provider refund, or proof of free pricing. Unknown costs must not be interpreted as zero. Inspect the provider's own usage page for billing and quota truth.

If you get `401`/`403`, replace or fix the gateway key. `429` can mean upstream rate limits or quota exhaustion; wait or choose an allowed alternative rather than repeatedly resubmitting. An empty catalog, an unavailable model, and an unreachable gateway are different failures. [Troubleshooting](troubleshooting.md) covers each.
