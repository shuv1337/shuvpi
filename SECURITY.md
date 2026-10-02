# Security Policy

Shuvpi is a coding agent that runs locally with the permissions of the user who starts it. It is not an operating-system sandbox. Users are responsible for reviewing its actions or running it inside a container, virtual machine, or other containment boundary.

Shuvpi treats the local user account and files writable by that account as inside the same trust boundary as the process. Someone who can modify the user's home directory, workspace, shell startup files, environment, or Shuvpi configuration can generally influence Shuvpi and other local developer tools. Reports that rely on prior access to write those files are not vulnerabilities unless they show how Shuvpi grants that access or crosses an operating-system privilege boundary.

Shuvpi also relies on users loading trusted extensions and skills and working only in repositories they trust. Files such as `AGENTS.md` and source comments can contain prompt-injection instructions; the agent cannot prevent those instructions from influencing its behavior.

## Reporting a vulnerability in Shuvpi

As of October 2, 2026, GitHub private vulnerability reporting is disabled for this repository. If GitHub enables it later, use [Shuvpi's private vulnerability reporting page](https://github.com/shuv1337/shuvpi/security/advisories/new).

Until then, open an issue in [shuv1337/shuvpi](https://github.com/shuv1337/shuvpi/issues) asking a maintainer to arrange a private contact. Do not include exploit details, proof-of-concept code, logs, or other sensitive information in that issue. The issue gate may close the request automatically, but the request remains visible to maintainers. You can identify maintainers through the [Shuvpi repository](https://github.com/shuv1337/shuvpi) or the [shuv1337 profile](https://github.com/shuv1337). Do not send reports to an unverified address.

Please include the affected package, version or commit, configuration, impact, and reproduction details after a private channel has been arranged. Do not disclose the issue publicly before coordinating with the maintainer.

Security issues that affect only the original upstream Pi project belong to its [upstream security policy](https://github.com/earendil-works/pi/security/policy), not this fork. Reports about Shuvpi's packages, CLI, or repository should use the Shuvpi process above.

## Scope

Security issues in Shuvpi's distributed packages, command-line tools, APIs, and repository code are in scope.

## Out of scope

- Local code execution or sandboxing behavior: the Shuvpi coding agent intentionally does not provide a sandbox.
- Behavior of user-installed extensions or skills.
- Risks from working in untrusted repositories.
- Risks from installing untrusted extensions, skills, packages, or tools.
- Issues caused by untrustworthy man-in-the-middle proxies.
- Public internet exposure of a Shuvpi installation.
- Prompt injection attacks.
- Exposed secrets that are third-party or user-controlled credentials.
- Reports requiring the ability to create, modify, delete, or replace user-controlled files, directories, symlinks, environment variables, shell configuration, or other local state. This includes `~/.shuvpi`, `~/.shuvpi/agent/models.json`, workspace files, `AGENTS.md`, skills, extensions, extension configuration, dotfiles, and files synchronized through NFS, roaming profiles, or dotfile managers, unless the report shows how Shuvpi itself grants that access.
- Issues caused by intentionally weakened user configuration.
- Resource-exhaustion claims that require trusted local input or configuration.
- Reports about malicious model output.
- User-approved or user-initiated local actions presented as vulnerabilities.

## Notes for reporters

The most useful reports show a current, reproducible security-boundary bypass with demonstrated impact. Reports that show expected local-agent behavior, prompt injection, or a malicious trusted extension or skill are not security vulnerabilities under this model.

For example, a report showing that malicious contents written to a trusted Shuvpi configuration file cause Shuvpi to execute commands, load attacker-controlled tools, send credentials to an attacker-controlled endpoint, or otherwise change behavior is out of scope unless it demonstrates how Shuvpi itself grants the required write access.

When possible, include the exact affected path, package version or commit, configuration, and a proof of concept against a current Shuvpi release or source revision. For dependency reports, show that the shipped dependency is affected and reachable through Shuvpi. For exposed-secret reports, show that the credential is owned by Shuvpi or grants access to a Shuvpi-operated service.
