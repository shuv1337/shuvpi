# Releasing Shuvpi

Shuvpi publishes the coding-agent CLI and its production workspace dependencies to npm. `scripts/release-packages.mjs` computes that dependency closure from the manifests, including optional and peer dependencies, in dependency-first order. Development-only client, protocol, server and unrelated examples are excluded. All public workspaces still share the same version.

The release destination is `shuv1337/shuvpi`, and selected packages must use the `@shuv1337/shuvpi-` scope. The CLI is `@shuv1337/shuvpi-coding-agent`. The installer uses npm; update checks query the installed package's metadata-derived npm name. Neither path redirects to another package supplied by a registry response.

## Local artifact validation

Run local release validation only when a build and isolated installation are authorized:

```bash
npm run release:local -- --out /tmp/shuvpi-local-release --force
cd /tmp
/tmp/shuvpi-local-release/node/shuvpi --help
/tmp/shuvpi-local-release/node/shuvpi --version
/tmp/shuvpi-local-release/node/shuvpi --list-models
/tmp/shuvpi-local-release/bun/shuvpi --help
/tmp/shuvpi-local-release/bun/shuvpi --version
/tmp/shuvpi-local-release/bun/shuvpi --list-models
```

The helper generates fresh model data, runs checks, builds only the selected production closure, runs `./test.sh`, packs local tarballs and installs a consumer outside the checkout. Only coding-agent is a direct dependency; overrides select the local tarballs for its declared dependencies. The consumer rejects installed development-only packages and checks the public SDK and both CLI entrypoints with isolated state and offline mode. It also creates a host-platform Bun binary and, unless `--skip-bun-install` is supplied, an isolated Bun package installation.

Verify a real prompt and interactive startup from both the Node package and compiled Bun binary before releasing. Run interactive sessions in tmux under the project's interactive-testing instructions and wait for a reply. These checks require separately authorized provider use. Unit fixtures that mock installation or compilation do not establish that actual release artifacts work.

`scripts/build-binaries.sh` retains darwin-arm64, darwin-x64, linux-arm64, linux-x64, windows-arm64 and windows-x64. It packages the architecture's native helpers, resize and codemode workers, themes, assets, export template, docs and examples. It can build one platform with `--platform`. Artifact names come from the CLI manifest. `--out` refuses checkout ancestors, source directories and symlink aliases; its normal `packages/coding-agent/binaries` directory is allowed. The local-release helper always requires an output directory outside the checkout.

## Initial 1.0.0 release

Upstream already has released `1.0.0` changelog sections. Keep those sections unchanged. Write and review fork release notes at `release-notes/1.0.0.md`, include them in the clean `release/1.0` branch, and validate the actual local artifacts before invoking:

```bash
SHUVPI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 \
  node scripts/release.mjs 1.0.0 --initial --branch release/1.0
```

This command commits, tags and pushes. It is not a dry run. The initial path accepts the existing version only for exactly `1.0.0` on `release/1.0`. Before changing files it checks the fork push destination, a clean checkout, absence of the local and remote tag, and absence of every selected package version from npm. Registry and Git errors stop the release. A package that is intentionally new must be named exactly in the comma-separated `SHUVPI_RELEASE_ALLOW_NEW_PACKAGES` environment variable; unselected names are rejected.

The initial release writes `release-notes/1.0.0.manifest.json` with the source commit, destination, branch, version, selected packages and notes path. It preserves existing released history and adds an empty `Unreleased` section only for the next cycle. Dependency hydration and lock updates disable lifecycle scripts. After validation it stages only expected release files, creates the release commit and tag, and atomically pushes the branch and tag. Unexpected concurrent changes stop staging.

## Later releases

Use `npm run release:patch` or `npm run release:minor` from a clean `main`, with the same lockfile permission and command-scoped npm age override. Major transitions and equal-version ordinary releases are rejected. The script updates every public workspace in lockstep, releases the `Unreleased` notes with the Pacific date, validates the selected production closure and pushes `main` and the tag atomically. Do not rerun the release script once a tag has been pushed.

## CI publication and recovery

The tag workflow in `.github/workflows/build-binaries.yml` publishes npm packages through GitHub Actions OIDC and the `npm-publish` environment. It verifies repository, scope, stable version and release tag before installation, then builds the production closure, runs checks, runs `./test.sh`, and smoke-tests the packed npm consumer. `publish.mjs` validates every selected package before publishing, accepts npm's array and keyed-object pack output, and skips versions already present in the registry. An unexpected registry response stops publication.

Only after npm succeeds does CI create the GitHub release. Initial `1.0.0` uses the separately reviewed fork notes; later releases extract notes from changelogs with the fork repository explicitly selected. Existing GitHub releases are left intact. CI currently publishes npm packages and release notes; the six-platform binary builder remains a local artifact tool.

Discord has one owner: the final CI job. It runs only when that workflow created the GitHub release, uses the optional `DISCORD_RELEASE_WEBHOOK_URL` secret, and posts a short version, npm link and tag link. Missing configuration skips the message; a failure does not fail publication. The notifier makes one bounded request and excludes webhook URLs and response bodies from errors. The local release script does not send a duplicate announcement.

For a failed publish, rerun the failed workflow or dispatch the existing tag. A recovery `source_ref` is permitted only when its package version matches the release tag; review that source ref before dispatch. Already published npm versions are skipped. A Discord-only failure can be retried by rerunning that failed job; rerunning an entire completed release sees the existing GitHub release and skips a duplicate announcement.
