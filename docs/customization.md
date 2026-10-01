# Make OpenAgents yours

Fork it, experiment, enhance it, and send improvements back. Preserve the applicable licenses, use synthetic fixtures, and keep real credentials out of your branch. See [licensing](licensing-and-credits.md) for the expression-engine exception.

## No-code configuration first

Use the app's settings to name bots, set their roles, select models, adjust appearance, and configure routines. Make small changes, run a small task, and inspect its result. Model selection, character identity, UI appearance, and permission grants solve different problems; changing one should not silently broaden the others.

## Where to change the code

| Goal | Starting points | What to verify |
| --- | --- | --- |
| Change colors, layout or themes | `web/src/theme.css`, `appearance.css`, `workspace-design.css`, `settings-design.css`, `tailwind.css` | Light/dark themes, narrow windows, focus visibility, contrast, reduced motion. |
| Change workspace interactions | `web/src/components/GrokWorkspace.tsx`, `GrokChat.tsx`, `GrokScreen.tsx`, `BotWorkspace.css` | Keyboard use, loading/errors, disabled states, stale requests, and history. |
| Create original bot silhouettes | `web/src/lib/aora-bot/shapes.ts`, `web/src/lib/botProfile.ts`, avatar components | Independent artwork, stable stored IDs, migration behavior, licensing boundaries. |
| Change character behavior | `src/daemon/character-*.ts`, `CharacterStudio.tsx`, `CharacterMemory.tsx`, `CharacterGrowth.tsx` | Off/parity, authority of evidence, consent/review, retention and schema compatibility. |
| Support another gateway | `src/daemon/provider-connections.ts`, provider UI and `src/evals/llm/` | Auth, redaction, redirects, model catalog validity, streaming, quota errors, served-model honesty. |
| Add a runtime tool | Tool schemas, dispatch/actions in `src/daemon/`, matching client transport | Authorization, host/container scope, cancellation, bounds, result provenance and hostile input. |
| Add a checked task type | `src/daemon/work-contract.ts`, `docs/examples/custom-task-contract.json` | Meaningful completion checks; model text alone must not count as proof. |
| Improve recurring work | `routine-*.ts`, `scheduler.ts`, routine UI components | Timezones, catch-up, serialization, missed runs, questions, and partial results. |
| Add OS credential support | `src/daemon/secret-store.ts` | A real OS-protected backend; no production use of the fixture memory store. |
| Improve packaging/startup | `desktop/src/`, `desktop/electron-builder.yml`, `desktop/tests/` | Fresh install, upgrades, sleep/wake, profile identity, port collisions, clean uninstall behavior. |

## A good extension workflow

1. Describe the behavior and the boundary it changes in an issue or PR.
2. Reproduce the current behavior with a small fixture.
3. Implement the change in its owning module, keeping UI and API contracts consistent.
4. Add a regression test that would fail on the old behavior.
5. Run the relevant checks and update the guide if setup or behavior changed.
6. Submit a focused PR with screenshots using synthetic data when the UI changed.

Avoid committing generated `dist/`, dependency trees, binaries, private task output, or your provider settings. Do not rewrite compatibility identifiers just to rename a UI label: cookies, database filenames, profile folders, encryption entropy, and container ownership labels may depend on them.

## Good first contributions

Documentation clarity, keyboard navigation, accessible error states, provider failure tests, Linux/macOS keyring support, and a smaller frontend bundle all help. A fully original permissively licensed expression implementation would help remove the current licensing exception; it must be independently implemented rather than a license-stripped copy of the existing engine.
