# pi-shuv vendor

Source: `/home/shuv/dotfiles/shuvpi/pi-shuv`

Source commit: `f98c53b519456836e28f026eae866369fe45246b`

The coding-agent build bundles `index.ts` and its third-party dependencies into
the built-in Shuv extension. Shuvpi host packages remain external so the
extension uses the release's own API and TUI instances.

Local patches:

- Runtime files that cannot live inside a Bun executable resolve through
  `features/assets.ts` and `getPackageDir()`.
- `image-gen` imports the legacy environment-key helper from the current
  `@shuv1337/shuvpi-ai/compat` export.
- The powerline bash editor imports `CustomEditor` through the narrow host
  subpath to avoid a package-root initialization cycle in Bun binaries.
- MCP regex safety uses recheck's self-contained browser implementation so it
  remains available inside standalone binaries without native sidecars.
- Background-terminal status widgets truncate ANSI-aware output to the render
  width so narrow terminals cannot violate the TUI line-width invariant.
- Package manifests, lockfiles, tests, plans, and development-only files are
  omitted. Runtime dependencies are pinned by the coding-agent package.

To refresh, copy the same source-only file set, preserve the local asset-path
patches, update the source commit above, then run the coding-agent build and its
focused tests.
