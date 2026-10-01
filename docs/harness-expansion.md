# OpenAgents 0.3.6 — remaining capability implementation

> Historical implementation notes retained for source context. Date-specific tests and delivery claims below are not verification of this public snapshot. Private raw evidence was excluded; use the current [setup](getting-started.md), [limitations](known-limitations.md), and [validation](validation.md) guides.


The capability work below is retained in **0.3.7**, which fixes the portable second-launch failure and adds Windows prerequisite setup. See the [startup fix and validation](getting-started.md). Use the 0.3.7 installer or portable executable; 0.3.6's unpacked checks did not exercise its portable launcher cleanup.

20 September 2026. This pass implements the missing-capability list discussed after the DeepSeek harness comparison. Existing work in the checkout was preserved. The Windows delivery folder is `<your-delivery-folder>`; rebuilding that folder does not migrate or restart the installed profile.

## Repository work

- **Large repositories:** `start_repository_work` and the repository API accept `paths`, a list of file/directory prefixes. GitHub selection resolves a commit, walks only relevant trees and checks each blob's Git object hash. Unrelated directories are not downloaded. A live selection against `deepseek-ai/deepseek-harness` fetched `README.md` and `LICENSE` successfully at commit `ddefc45fbc7f8e46dd73185e68295696d1297887`.
- **Larger bounded snapshots:** fetcher defaults are 64 MiB compressed, 128 MiB expanded, 20,000 files and 2 MiB per file. Selection is limited to 100 prefixes and 400 API requests; GitHub's own rate limits still apply. Include build manifests and acceptance tests in a selected snapshot. Dependency directories, symlinks and unsupported paths are reported rather than imported.
- **Uncommitted local work:** use a configured `local/alias` and `workingTree: true`. Modified/deleted tracked files and untracked non-ignored regular files are captured. Common environment/key files are excluded. The live checkout is not changed. Queued work uses saved snapshot bytes, including across restart, rather than recapturing a moving working tree.
- **Binary files:** snapshots stage their actual bytes. `register_file` captures a file created or changed by a sandbox command. Binary artifacts download as their original bytes, not base64 text files.
- **Deletion and rename:** `delete_file` removes one file; `rename_file` moves one to an unused path. Verification rebuilds the final workspace in a fresh container. `openhours-review/changes.json` records deletions and binary files, while text changes retain unified patches. Publication verifies the manifest and artifact hashes, creates Git blobs for binary content and uses explicit tree deletions. The approval preview distinguishes binary content and deletions.

The existing 16 changed-path limit remains. Text delivery is bounded to 1 MiB; binary delivery to eight files / 8 MiB, with each registered file at most 2 MiB. Snapshot storage is bounded to 512 MiB. New file modes use the publisher's existing default; replacement of an existing remote executable preserves its mode. Fork publication, arbitrary filesystem paths and symbolic-link edits remain unsupported.

Example: request `local/my-project` with `workingTree: true`, or `deepseek-ai/deepseek-harness` with `paths: ["README.md", "LICENSE"]`. Selection is explicit; it does not automatically infer every dependency needed to run a repository's tests.

## OCR and Office documents

OCR uses bundled English and Arabic Tesseract data and local PDF rendering. It performs no inference or language-data downloads. Images retain their original bytes and vision support, with OCR text added when applicable. PDF pages with little extractable text are rendered for OCR. Transcriptions include confidence and require checking against the source.

Inputs remain at most 2 MiB. Image/rendered-page processing is bounded to four megapixels, document extraction to 40 pages and OCR to ten scanned pages. The worker deadline is 90 seconds; the JS heap limit remains 128 MiB and is not an OS memory limit. Large scans should be split. OCR is not a guarantee of correct handwriting, tables or mathematical notation.

`create_document` now supports:

- `template`: `standard`, `executive` or `academic` typography and styling presets.
- DOCX paragraphs, headed sections and tables.
- XLSX scalar cells and explicit `{ "formula": "SUM(A2:A3)*2" }` values. The bounded numeric evaluator supports arithmetic, cell references, ranges, SUM, AVERAGE, MIN, MAX and COUNT; unsupported functions, nonnumeric referenced cells and circular references are rejected. Formula-like plain strings remain literal. Cached results are written into real spreadsheet formulas.
- Native XLSX bar, line and pie chart parts, with embedded chart data.
- PPTX bullet, two-column, table and native chart slide layouts.

These are built-in templates and bounded layout options, not arbitrary Office template importing. Package structure, formula results and readable content are tested. Microsoft Office/LibreOffice rendering parity and a visual review of every layout are not certified by these checks.

## Plugin reload and background work

Plugin install/remove now attempts live MCP reload. There is also **Reload plugins** in the marketplace and `POST /api/plugins/reload`. Replacement connections complete their handshake/tool discovery before replacing the old connection. Failed replacement retains the previous connection and exposes an error. Reload is refused while an MCP call is active; retry after the call. Per-run quotas survive replacement, and reload reads current agent MCP permissions from configuration. This does not automatically watch arbitrary file edits or grant new plugins to every bot.

`background_start`, `background_status` and `background_continue` provide a durable pool using the existing scheduler. Background work has its own queued run, uses global concurrency and sponsored budgets, and honors cross-bot delegation permissions and target approval requirements. There are at most four active background tasks per owner and 24 steps per attempt. Nested delegation is disabled.

Text files and bounded execution context are checkpointed. **Background tasks** in chat lists attempts and provides continuation instructions. Queued definitions and checkpoints survive daemon restart. A running attempt interrupted by a crash requires explicit continuation; the runtime does not replay it automatically. An uncertain external action requires operator acknowledgement after inspection before continuation. Shell processes/browser state and undelivered binary drafts are not restored.

## Context recovery

Recognized provider context-length rejection gets at most two smaller-request retries. Recovery strips old tool/assistant payloads, preserves operator requests and steering, and flattens old native tool pairs without replaying actions. Normal compaction also preserves exact operator messages. If the retained request itself cannot fit, the task stops with an actionable smaller-task instruction. Token estimates remain heuristic; exact provider tokenization is not claimed.

## Delivery and qualification

The validation record is [here](validation.md). The release is a locally rebuilt Windows installer and portable application. Existing 0.3.5 installers remain in the destination as previous versions; the README identifies 0.3.6 and records its checksums.

Signing, an operator-owned update feed, paid/live-provider acceptance, private credentialed GitHub publication, clean-machine installation/upgrade/uninstall, graphical sleep/wake, and macOS/Linux qualification remain separate production-release checks. These are not represented as completed by a local rebuild.

Implementation references: [Tesseract local installation](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md), [PptxGenJS charts](https://gitbrent.github.io/PptxGenJS/docs/api-charts/), [docx tables](https://github.com/dolanmiu/docx/blob/master/docs/usage/tables.md), and the earlier [DeepSeek comparison](architecture.md).
