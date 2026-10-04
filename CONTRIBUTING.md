# Contributing to shuvpi

Thanks for wanting to contribute! This guide exists to save both of us time.

## The One Rule

**You must understand your code.** If you can't explain what your changes do and how they interact with the rest of the system, your PR will be closed.

Using AI to write code is fine. You can gain understanding by interrogating an agent with access to the codebase until you grasp all edge cases and effects of your changes. What's not fine is submitting agent-generated slop without that understanding.

If you use an agent, run it from the `shuvpi-mono` root directory so it picks up `AGENTS.md` automatically. Your agent must follow the rules and guidelines in that file.

## First-Time Contributors

We use an approval gate for new contributors:

1. Open an issue describing what you want to change and why
2. Keep it concise (if it doesn't fit on one screen, it's too long)
3. Write in your own voice, at least for the intro
4. A maintainer will comment `lgtm` if approved
5. Once approved, you can submit PRs

This exists because AI makes it trivial to generate plausible-looking but low-quality contributions. The issue step lets us filter early.

## Before Submitting a PR

```bash
npm run check  # must pass with no errors
./test.sh      # must pass
```

Do not edit `CHANGELOG.md`. Changelog entries are added by maintainers.

If you're adding a new provider to `packages/ai`, see `AGENTS.md` for required tests.

## Philosophy

shuvpi's core is minimal. If your feature doesn't belong in the core, it should be an extension. PRs that bloat the core will likely be rejected.

## Publishing a new package

Maintainers only. npm trusted publishing cannot create a package. Before a new public workspace package is included in a release:

1. Build it, then from its directory publish it once with an npm account that can publish the scope (not GitHub Actions):
   ```bash
   npm publish --access public --ignore-scripts
   ```
2. Attach the trusted publisher used by `.github/workflows/build-binaries.yml` (`publish-npm`, environment `npm-publish`) and allow publish. This requires npm 11.15 or newer and account 2FA:
   ```bash
   npm trust github <name> --repo shuv1337/shuvpi --file build-binaries.yml --env npm-publish --allow-publish
   ```
3. Confirm bootstrap with `npm view <name> version`.

`SHUVPI_RELEASE_ALLOW_NEW_PACKAGES` does not skip this. The release script rejects a package until that `npm view` succeeds. CI then exchanges an OIDC token for every unpublished package in the closure before it publishes any of them. See `AGENTS.md` for the rest of the release steps.

## Questions?

Open an issue or ask on [Discord](https://discord.com/invite/nKXTsAcmbT).
