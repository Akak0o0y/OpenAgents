# Public snapshot validation — 1 October 2026

This records checks on the sanitized **0.6.1 community source snapshot**, on Windows with Node **24.11.0**. It is not a signed-binary release certificate or a claim of cross-platform production readiness.

## Results

| Check | Result |
| --- | --- |
| Clean `npm ci` in root, `web`, and `desktop` | Passed from the committed lockfiles. npm emitted dependency deprecation notices. |
| Backend TypeScript build | Passed. |
| Frontend type checking and production bundle | Passed; Vite reported a large-chunk warning. |
| Full frontend suite | **522 passed**, 56 files. Seven stale assertions were updated to match the current idle/snapshot labels and intentional non-disclosure of raw model reasoning; no product behavior was weakened. |
| Desktop suite | **84 passed**. |
| Focused config/auth/env/brand/provider suite | **47 passed**, including a Windows DPAPI round trip. |
| Publication guard regression | **1 passed**; covers staged private files, private-key markers, binary media, legitimate source data, and staged-vs-working-tree content. |
| Broad daemon suite | **783 passed, 52 failed, 5 skipped** (840 total). **Not green.** |
| Browser suite | **88 passed, 13 failed** (101 total). **Not green.** |
| Live model/provider and real account effects | Not qualified by this publication pass. |
| Docker-backed end-to-end execution | Not qualified; the Docker Desktop Linux engine was stopped/unreachable. |
| Fresh-machine installer, upgrade, Linux/macOS packages, signing | Not qualified by this source publication. |

The focused suite is reproducible with:

```bash
npm run build
node --test --test-concurrency=1 dist/tests/config-file.test.js dist/tests/local-auth.test.js dist/tests/env-alias.test.js dist/tests/brand-compat.test.js dist/tests/brand-audit.test.js dist/tests/provider-connections.test.js
node --test scripts/check-public-tree.test.mjs
```

The full suite commands are in [development](development.md). Some named tests intentionally use mocked provider responses or intercepted site responses; they do not establish real provider billing, real account access, or successful public posting.

## Failures contributors can investigate

- `tests/chat-proposals.test.ts` independently reproduces three failures with `Cannot start task run in "FAILED" status`. Review ownership between chat admission, queued tasks, and the scheduler. This was not dismissed as a Docker-only issue.
- A work-runtime concurrency expectation failed after `Resource wait exceeded five minutes`; the expectation still described immediate concurrency rejection. Determine intended waiting/admission behavior and test it with bounded fixtures.
- Container-dependent groups fail without an available Docker engine. Repeat them against an isolated test engine before attributing all failures to implementation defects.
- The 13 browser-suite failures occur in `tests/publish-honesty.test.ts`, including assertions affected by result-verification text. Review intended truthful-result behavior before changing assertions.

These are published limitations of this early source release. See [known limitations](known-limitations.md). The public CI checks cover named build/component/contract checks; they are not a replacement for the broader suites above.

## Publication privacy review

The snapshot was assembled in a separate clean clone on top of the repository's existing public initial commit. Private local development history was not imported. Personal configuration, `.env`, databases and auth files, browser state, raw local reports, research captures, private planning material, scratch files, build outputs, and dependency folders were excluded.

The staged tree was checked for forbidden paths, personal identifiers, accidental generated files, and secret patterns. Gitleaks **8.30.1** initially flagged three SHA-256 source checksums in the character-baseline manifest. Each was reviewed as a checksum, and `.gitleaks.toml` allows only those three named checksum entries in that exact manifest. The resulting scan found no unreviewed secret matches. Public-history scanning is also configured in CI.

No automated scan proves absolute absence of sensitive information. Review subsequent commits and attachments with the same care. Copyright/author credits belonging to dependencies were retained. Demo media uses synthetic conversations and original project artwork; the voice-only video has the same visual edit and narration with no music bed.
