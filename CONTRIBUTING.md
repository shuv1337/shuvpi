# Contributing to Shuvpi

Shuvpi is maintained in [shuv1337/shuvpi](https://github.com/shuv1337/shuvpi). Issues and pull requests should describe a concrete problem or change in this fork. Include a reproducible example when reporting a bug, and explain the user-visible effect of a proposed change.

Before changing code, read [AGENTS.md](AGENTS.md) for repository conventions and package-specific requirements. Keep changes focused, preserve upstream credits and source links, and do not remove behavior that appears intentional without discussing it in the pull request.

## Validate changes

For code changes, run the repository checks and non-e2e tests:

```bash
npm run check
./test.sh
```

Do not run `npm run build` or `npm test` unless the task specifically requires them. If you add or change a test, run that test and fix failures before submitting. Provider tests must use fixtures; do not use real credentials or paid API calls. New provider work must follow the testing requirements in [AGENTS.md](AGENTS.md).

Keep changelogs under the affected package's `CHANGELOG.md` and follow the rules in `AGENTS.md`. Do not edit released version sections. Release preparation and publication steps are documented in [the Shuvpi release guide](packages/coding-agent/docs/releasing.md); release commands can create commits, tags, and pushes, so review their effects before running them.

## Issue and pull request gates

The checked-in GitHub Actions workflows apply these contributor gates when Actions runs:

- On a newly opened issue, the issue gate leaves it open for collaborators with admin, maintain, or write access, `dependabot[bot]`, `sentry[bot]`, `claude[bot]`, and users recorded in `.github/APPROVED_CONTRIBUTORS` with `issue` or `pr` capability. Other new issues receive a comment, the `untriaged` label, and are closed as `not_planned`.
- On a newly opened pull request, the PR gate leaves it open for collaborators with admin, maintain, or write access, `dependabot[bot]`, `sentry[bot]`, `claude[bot]`, and users recorded with `pr` capability. Other new pull requests receive a comment and are closed.
- A collaborator with write access can approve the issue author or mentioned users by commenting `lgtmi` (issue capability) or `lgtm` (issue and pull request capability) at the start or end of an issue comment. The approval workflow records those capabilities in `.github/APPROVED_CONTRIBUTORS`.

These workflows describe the repository automation; they do not claim that additional GitHub branch-protection requirements are configured. Read the workflow files for the current bot allowlist and exact behavior.

## Quality bar

Keep reports and proposed changes concise, specific, and reproducible. Explain the impact and include relevant package, version, commit, configuration, or logs. Do not publish secrets or sensitive vulnerability details in a public issue; follow [SECURITY.md](SECURITY.md) instead.

Maintainers review contributions before merge. A pull request is not accepted until a maintainer approves it.

## Useful links

- [Issues](https://github.com/shuv1337/shuvpi/issues)
- [Security policy](SECURITY.md)
- [Release guide](packages/coding-agent/docs/releasing.md)
