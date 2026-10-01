# Security policy

This early community release does not offer a supported-version SLA or a security guarantee. Reports about the current public source are welcome. Do not use an unreviewed agent deployment for sensitive production work merely because unit tests pass.

## Report a vulnerability

Use GitHub's **Security → Report a vulnerability** private-reporting flow if it is enabled for this repository. If it is unavailable, open an issue saying only that you need a private reporting channel; do not post exploit details, keys, tokens, private URLs, or user data publicly. A maintainer can arrange a suitable channel.

Include the affected commit/version, subsystem, impact, prerequisites, and a minimal synthetic reproduction. Do not test an exploit against other people's accounts, machines, or services. No bounty or response-time commitment is offered.

## Accidental credential exposure

Revoke/rotate the credential at its provider immediately. Removing the latest file alone does not revoke it or erase Git history. Tell maintainers which path/commit is affected without reposting the secret. Coordinate any history cleanup because it affects forks and collaborators.

## Trust boundaries

Keep the daemon on loopback. Protect the local auth file, databases, browser sessions, and provider credentials. MCP servers are host processes, Docker socket access is powerful, and browser actions can have real effects. The Windows DPAPI store is the only implemented production provider-key backend; the memory store is a fixture only. See [privacy and security](docs/privacy-and-security.md).
