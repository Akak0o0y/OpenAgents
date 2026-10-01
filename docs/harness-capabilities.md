# Harness capability completion pass

> Historical implementation notes retained for source context. Date-specific tests and delivery claims below are not verification of this public snapshot. Private raw evidence was excluded; use the current [setup](getting-started.md), [limitations](known-limitations.md), and [validation](validation.md) guides.


Follow-up: the [0.3.6 implementation](harness-expansion.md) addresses the missing-capability list below. This page retains the preceding implementation snapshot and its original bounds.

19 September 2026. These changes extend the existing dirty OpenAgents worktree. They are local and uncommitted; the installed app and its profile have not been replaced. This is a bounded capability implementation, not a claim that every remaining item in the earlier architecture review or production release checklist is complete.

## Implemented

| Workflow | Behavior and limits |
|---|---|
| Local repositories | Configure a checkout alias; request `local/alias@ref`. Git exports a pinned commit without touching the checkout. Dirty/untracked files are excluded. Existing snapshot bounds still apply. |
| Private GitHub repositories | A destination-specific credential environment variable enables authenticated archive acquisition. Credentials stay in the daemon, are not passed through redirects and never enter the coding sandbox. |
| GitHub publication | The workspace panel provides a publication preview and a separate approval button. Only unchanged artifacts from a completed, verified GitHub run qualify. The selected base branch must still equal the verified commit. Creates a new branch and draft PR in the same repository; never merges or overwrites a branch. Workflow files are refused. |
| Publication recovery | The preview digest fixes destination, base, title and exact file bytes. The commit and uncertain PR dispatch are persisted. Retries reconcile the existing branch/PR; an uncertain PR POST is never blindly repeated. Remote effects are recorded in the execution audit trail. |
| Saved questions | `ask_user_question` persists working text files, bounded execution context and the contract. The current attempt ends and releases its slot. Answering queues one new attempt; the same answer is idempotent across restart. Questions have their own UI, separate from approval cards. |
| Delegation | Self-delegation remains available. Other bots require an explicit caller-to-target grant. Both parent and target budgets include sponsored spend. Synchronous children borrow their suspended parent's concurrency slot. Target approval requirements still apply. Cross-bot delegation through unpriced gateways is refused. |
| Office output | `create_document` produces real DOCX paragraphs, scalar XLSX tables and PPTX bullet slides. Binary files commit atomically with the answer/result. Package structure is checked; factual content and visual layout are not certified. |
| Document input | PDF text and DOCX/XLSX/PPTX content are extracted in workers with a 15-second deadline and 128 MiB JS heap limit. Original bytes are retained for download. Macros/embedded objects are refused. PDFs are limited to 40 pages; spreadsheets to 10 sheets, 500 rows and 30 columns. Extraction reports its bounds. Scanned PDFs need OCR, which is not supplied. |
| Image input | PNG/JPEG/WebP are stored as attachments and sent as typed image parts through OpenAI-compatible, Anthropic and Gemini adapters. Vision requires explicit model opt-in. Images are previewed in chat and are never inlined as base64 prompt text. |
| Windows containment | The WSL Docker launcher now uses `--exec`, preventing a host shell from expanding Docker arguments. A real host-side negative control verifies literal expansion syntax. The earlier empty `INJECTED` test marker was removed. |
| Packaging | Preserves dependency directories named `doc`: ExcelJS uses `lib/doc` as executable source. The previous packaging exclusion broke the packaged runtime despite passing source tests. A reproducible packaged smoke script covers Office creation, document/PDF extraction and image workers, including PDF font asset loading. |

## Configuration

Merge these keys into the operator's existing configuration. No live configuration was changed in this pass.

```json
{
  "repositories": {
    "local": { "my-project": "C:/projects/my-project" },
    "github": [
      { "repository": "owner/repository", "tokenEnv": "OPENHOURS_GITHUB_TOKEN", "publish": true }
    ]
  },
  "visionModels": ["the-exact-verified-vision-model-id"]
}
```

`local` paths can be relative to the configuration file. `publish` defaults to false. GitHub archive access needs repository Contents read permission; publication additionally needs Contents and Pull requests write permission. Keep the actual token outside the configuration and repository, in the daemon's environment. The configured destination must match the task repository. Fork publication is not implemented. See GitHub's [archive API](https://docs.github.com/en/rest/repos/contents#download-a-repository-archive-tar), [Git trees API](https://docs.github.com/en/rest/git/trees#create-a-tree), and [pull request API](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request).

To authorize delegation, add `"delegateTo": ["specialist-bot-id"]` to the calling agent's existing entry. This grants use of that bot's configured capabilities, so choose targets deliberately. A missing grant denies cross-bot execution. Self-delegation uses the same bot's budget and authority.

Use Node 22.13 or newer for source installations. The packaged application carries its own compatible runtime. Document dependencies are pinned; overrides select patched UUID and image-size versions. `npm audit` reported no known vulnerabilities after installation.

## User flow

1. Request code work with an owner/repository or configured local alias. Review the pinned commit and test command before queuing it.
2. Once a GitHub run completes successfully, open its workspace and expand **Create a GitHub pull request**. Enter the base branch and title, review the exact file preview, then explicitly approve creating the draft.
3. If a task raises a saved question, choose an option or enter an answer. It survives daemon restart; cancellation prevents a continuation. The resumed attempt delivers its answer to the originating conversation.
4. Attach supported documents or images through the existing chat attachment control. Ask for an Office file in normal conversation; the bot uses `create_document`, then provides a download.

## Bounds and remaining work

- Repository snapshots remain text-oriented: 8 MiB archive, 32 MiB expansion, 2,000 text files, 256 KiB per file. Coding deliverables remain limited to 16 registered text paths / 1 MiB. Repository binary assets, explicit deletion/rename tools, dirty local snapshots and large-repository selection are still outside this pass. The full DeepSeek repository still exceeds the default ingestion scope.
- Saved questions are available for operator tasks, not autonomous routines, missions or delegated children. They checkpoint text files and context, not running shells, browser state or arbitrary instruction replay. Generated binary drafts must be delivered before asking a question. The parked attempt is recorded with an incomplete outcome and question metadata; answering creates a linked new attempt rather than rewriting history.
- Attachments are bounded to 2 MiB each, at most four per request, with 64 MiB total stored JSON. Images are limited to four megapixels / 4096 pixels per side. Office output allows eight files / 8 MiB per run, 4 MiB each. Questions and publication records have separate 32 MiB / 64 MiB storage caps. Attachment parsing bounds the worker's JS heap; it is not an OS container memory limit.
- Office output is deliberately basic. Spreadsheet formulas/charts, arbitrary slide layouts, templates, OCR, document rendering and visual export review need additional work. No visual qualification of the new UI or generated Office layouts was performed in this pass.
- Local fixtures verify vision payloads and private-repository routing. A live supported-model acceptance matrix and credentialed private GitHub/PR acceptance run are not completed. The requested destination for the live PR test is still needed; no production PR was created.
- General plugin hot reload, a background continuable agent pool, exact model tokenization, provider overflow recovery and semantic retrieval evaluation remain as recorded in the earlier review.
- The Windows directory package builds and its capability smoke passes. Authenticode reports **NotSigned**; `desktop/update-channel.json` is absent. Production signing/update ownership, clean-machine installation/upgrade/uninstall, graphical sleep/wake and macOS/Linux qualification remain release gates. A ten-minute synthetic soak does not establish sustained production reliability.

## Reproducing the checks

`npm test` now includes `test:completion`. Also run `npm --prefix web test`, `npm --prefix web run typecheck`, and `npm run test:desktop`. Keep Docker-backed suites sequential.

Build the Windows directory package with `npm --prefix desktop run dist:dir -- --config.directories.output=release-harness-20260919`, after building backend and web. Then run `node scripts/verify-packaged-capabilities.mjs`; it uses the packaged executable and dependencies in an isolated temporary profile without opening or replacing the installed app.

The evidence record is [the validation log](validation.md). The earlier DeepSeek comparison remains [available here](architecture.md); its original snapshot is historical, with this document recording the follow-up implementation.
