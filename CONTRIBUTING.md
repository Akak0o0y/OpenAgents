# Contributing to OpenAgents

**This project is for you.** Customize it, improve it, fix problems, teach us something, and help other developers. You do not need to be an expert to contribute. Good documentation, a small reproducible bug, a clear test, or a careful accessibility improvement can be as useful as a new feature.

Read the [README](README.md), [setup](docs/getting-started.md), [architecture](docs/architecture.md), and [license boundaries](docs/licensing-and-credits.md). MIT terms apply to OpenAgents-authored code; separately licensed vendored material keeps its own terms.

## Pick work

Check existing [issues](https://github.com/Akak0o0y/OpenAgents/issues) and [pull requests](https://github.com/Akak0o0y/OpenAgents/pulls) before starting. For a large redesign, API change, new dependency, or licensing change, discuss the concrete proposal first. Small fixes can go straight to a focused PR.

For a bug, explain what you did, what you expected, what happened, the OS/version/commit, and how to reproduce it with fake/public data. Redact diagnostics. Do not attach `.env`, an auth token, a browser profile, or a real database. Security issues follow [SECURITY.md](SECURITY.md).

## Fork, install, and make a branch

Fork on GitHub, clone your fork, and add the upstream remote:

```bash
git clone https://github.com/YOUR-USERNAME/OpenAgents.git
cd OpenAgents
git remote add upstream https://github.com/Akak0o0y/OpenAgents.git
git switch -c fix/describe-the-change
npm ci
npm --prefix web ci
npm --prefix desktop ci
```

Replace `YOUR-USERNAME` with your public GitHub handle. Use a GitHub no-reply email in your Git configuration if you want to keep your personal email out of public commits. Keep your real profile outside the checkout and use the ignored templates described in [configuration](docs/configuration.md).

## Make the change reviewable

- Keep one clear problem per PR; explain the user-visible result.
- Follow nearby TypeScript/React/module conventions and keep type checks passing.
- Add a meaningful regression test for behavior changes. For docs-only work, check commands and links.
- Preserve expired-approval, authentication, cancellation, budget, isolation, and provenance checks.
- Use actual results in the UI; do not replace errors/missing data with simulated success.
- Preserve stored IDs, compatibility aliases, and versioned schemas unless the PR includes a safe migration.
- Keep third-party notices. Do not submit copied proprietary code, restricted reference captures, or private data.
- Review generated code as carefully as handwritten code. You are responsible for understanding and validating your contribution.

Run at least the relevant checks from [development](docs/development.md). Include both what passed and what was not run. Docker/browser/live-provider/installer checks have different prerequisites; do not call them covered by a mocked test.

Before committing:

```bash
git status --short
git diff --check
git diff
git add <specific-files>
git diff --cached --stat
git diff --cached
node scripts/check-public-tree.mjs
```

The public-tree check inspects staged paths and obvious private-material markers. It complements, rather than replaces, a secret scanner and human review. Never use `git add -f` to sneak private files past ignore rules. Keep build outputs and personal reports local.

## Open a pull request

Push your branch to your fork and open a PR against `Akak0o0y/OpenAgents:main`. Explain the problem, the solution, relevant tests, and remaining limitations. For UI work, attach screenshots with synthetic data. For provider work, describe the protocol/model behavior without including a key. For a bug fix, link the issue with a closing keyword when appropriate.

Maintainers may request a smaller scope or more evidence. Keep review respectful and respond to technical questions. We welcome corrections and disagreement supported by reproducible examples. No response time or merge outcome is guaranteed for this volunteer project.

## Credit and community

Thank you to FreeLLMAPI and all the developers behind the project's dependencies, and thank you for improving OpenAgents. Contributions should be shared under the applicable project/component license; do not include work you lack permission to contribute. See the [code of conduct](CODE_OF_CONDUCT.md).
