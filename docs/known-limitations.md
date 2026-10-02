# Known limitations and contribution areas

This is an early community source release. The code is available for inspection and improvement; it is not a promise that every advertised platform, model, or external workflow is production-qualified.

**The broader runtime and browser test suites are currently not green.** Publication checks reproduced a chat/task ownership failure (`Cannot start task run in "FAILED" status`), a concurrency test waiting until its resource timeout, and publication-result assertion failures. Docker was also unavailable for container-dependent checks. These are distinct from the passing build, frontend, desktop, and focused configuration/provider checks. See [validation](validation.md) for exact counts and reproduction commands.

- **Platform parity:** Windows is the main desktop target. macOS/Linux package builds, signing/notarization, account persistence, and OS integration need qualification. Saved provider-key storage currently has only a Windows DPAPI production backend.
- **Licensing:** The bundled Aora expression engine/emotion data have separate non-commercial terms. A fully original permissively licensed replacement is a useful contribution area. See [licensing](licensing-and-credits.md).
- **Provider cost and availability:** No free model quota is guaranteed. The default/sample model can be paid. Gateway/model capabilities, served-model identity, rate limits, and catalogs can change.
- **External actions:** A complete autonomous issue-to-fix-to-reviewed-publication workflow depends on credentials, repository permissions, tests, and operator decisions. A model's claim is not publication proof.
- **Browser boundaries:** Auto isolation can fall back to a host-managed browser; choose sandbox-only mode when required. Account grants and changed-page/account checks still matter.
- **X research:** Public X search can return only a loading shell or no usable post text/engagement. Draft routines should report that limit, skip unverifiable candidates, and leave every draft unsent. This preview does not guarantee access to live X posts or metrics.
- **Routines and persistence:** The runtime must remain running for scheduled work. Recovery, sleep/wake behavior, long sessions, and large data histories need more real-world coverage.
- **Memory and character growth:** Model-generated summaries/interpretations can be incomplete or wrong. Keep evidence-backed claims, proposals, approvals, and user-provided identity separate.
- **Calibration:** Runtime constants marked provisional are estimates. A passing unit test does not establish statistically calibrated limits.
- **Storage:** Completed workspaces and accumulated results can consume disk. There is no claim of a comprehensive automatic retention/cleanup policy for every data class.
- **Performance and dependencies:** The frontend bundle is large. Native modules/browser/packaging tools create installation and platform compatibility work; dependency findings need ongoing review.
- **Packaging:** An [unsigned Windows x64 preview](try-windows.md) is available. It is not a production-qualified release; fresh-machine installation, versioned upgrades, Docker-backed live tasks, and macOS/Linux packaging remain unqualified. Portable extraction can be slow. Release-gate success alone does not replace clean-machine, upgrade, and live daily-use checks.

Useful contributions include reproducible bug reports, safer cross-platform credential storage, better tests for provider failures, accessible UI, clean-install verification, clearer docs, and independent original artwork/animation. The latest publication checks are recorded in [validation](validation.md); limitations are not represented as passing tests.
