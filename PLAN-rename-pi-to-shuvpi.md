# PLAN: Full `pi` / `shuvcode` rebrand to `shuvpi`

## Goal

Rebrand every active, fork-owned identity surface in this monorepo to `shuvpi` so the fork can be installed and used alongside a native upstream Pi build without package, binary, config, environment-variable, or user-facing ambiguity.

This is a clean break. Do not preserve `pi` or `shuvcode` aliases unless a concrete external dependency requires an explicitly documented exception.

## Canonical identity

| Surface | Canonical value |
|---|---|
| Product / app name | `shuvpi` |
| Primary coding-agent binary | `shuvpi` |
| AI helper binary | `shuvpi-ai` |
| Pods helper binary | `shuvpi-pods` |
| Root package | `shuvpi-monorepo` |
| npm package prefix | `@shuv1337/shuvpi-*` |
| Pods npm package | `@shuv1337/shuvpi-pods` |
| Config manifest key | `shuvpiConfig` |
| Extension manifest key | `shuvpi` |
| Global/project config directory | `.shuvpi` |
| Environment prefix | `SHUVPI_` |
| TypeScript brand casing | `Shuvpi*` / `shuvpi*` |
| Browser/storage/custom-element prefix | `shuvpi-*` / `shuvpi:*` |
| Binary/archive prefix | `shuvpi-*` |

## Guardrails and exceptions

- Do not commit; the user did not request a commit.
- Do not run `npm run build` or `npm test`. Run modified tests directly, then `npm run check`.
- Do not edit generated `packages/ai/src/models.generated.ts` directly.
- Preserve released changelog sections and frozen session fixtures.
- Preserve upstream issue/PR/source URLs when they are provenance rather than this fork's repository identity.
- Preserve external `@mariozechner/jiti`, `@mariozechner/mini-lit`, and `@mariozechner/clipboard*` dependencies.
- Keep the current repository path and GitHub remote (`shuv1337/pi-mono`) unless the user separately authorizes an external repository rename.
- Keep `https://pi.dev/session/` only as an upstream share-viewer service endpoint; rename its environment override to `SHUVPI_SHARE_VIEWER_URL` and document the external-service exception.
- Do not migrate or delete the user's existing `~/.pi` data automatically. The renamed runtime starts at `~/.shuvpi`; migration remains an explicit manual follow-up.

## Phase 0: Fresh inventory and exclusions

- [x] Capture active identity files while excluding released changelog history, frozen JSONL fixtures, dependencies, generated output, and prior plan artifacts.
- [x] Record deliberate external/provenance exceptions so final grep validation can distinguish them from missed active branding.
- [x] Confirm the worktree is clean before edits and preserve unrelated concurrent changes if any appear later.

## Phase 1: Package graph and build identity

- [x] Rename the root package to `shuvpi-monorepo` in `package.json`.
- [x] Rename workspace packages and all internal dependencies/imports/path aliases:
  - `@shuv1337/pi-ai` -> `@shuv1337/shuvpi-ai`
  - `@shuv1337/pi-agent-core` -> `@shuv1337/shuvpi-agent-core`
  - `@shuv1337/pi-coding-agent` -> `@shuv1337/shuvpi-coding-agent`
  - `@shuv1337/pi-orchestrator` -> `@shuv1337/shuvpi-orchestrator`
  - `@shuv1337/pi-mom` -> `@shuv1337/shuvpi-mom`
  - `@shuv1337/pi-tui` -> `@shuv1337/shuvpi-tui`
  - `@shuv1337/pi-web-ui` -> `@shuv1337/shuvpi-web-ui`
  - `@shuv1337/pi` -> `@shuv1337/shuvpi-pods`
- [x] Rename coding-agent, AI, and pods bins to `shuvpi`, `shuvpi-ai`, and `shuvpi-pods`; remove both `pi` and `shuvcode` bin aliases.
- [x] Rename compiled binary outputs and release archive contents from `pi` to `shuvpi` in `packages/coding-agent/package.json`, `scripts/build-binaries.sh`, and local-release/release scripts.
- [x] Update package publishing, pinned-dependency, shrinkwrap, install-lock, browser-smoke, and TypeScript alias scripts to the new package prefix.
- [x] Remove dead `@shuv1337/pi-agent-old` path mappings rather than carrying them into the new namespace.

## Phase 2: Runtime config, manifests, and environment variables

- [x] Replace `piConfig` with `shuvpiConfig` in `packages/coding-agent/package.json`, `packages/coding-agent/src/config.ts`, docs, and tests.
- [x] Set runtime identity to `APP_NAME = "shuvpi"`, `APP_TITLE = "shuvpi"`, `CONFIG_DIR_NAME = ".shuvpi"`, and the new package fallback.
- [x] Rename extension manifest structures and readers (`PiManifest`, `readPiManifest*`, `pkg.pi`) to `ShuvpiManifest`, `readShuvpiManifest*`, and `pkg.shuvpi`.
- [x] Rename all active fork-owned `PI_*` environment variables to `SHUVPI_*` across source, scripts, workflows, tests, examples, and docs.
- [x] Rename active `.pi` / `~/.pi` config, session, auth, cache, temp, debug-log, and extension-discovery paths to `.shuvpi` / `~/.shuvpi`.
- [x] Rename product-owned process titles, originator/user-agent/request prefixes, cache keys, HTML meta keys, custom elements, IndexedDB names, and temp paths from `pi` to `shuvpi`.

## Phase 3: Source API and active identifiers

- [x] Rename active product-specific TypeScript identifiers (`PiManifest`, `piConfigName`, `piDir`, branded loader-entry variables, observability API names, and equivalent symbols) to `Shuvpi*` / `shuvpi*` where they represent this product.
- [x] Preserve unrelated mathematical/provider/domain uses of “pi” only when inspection confirms they are not product branding.
- [x] Update source comments, error messages, help text, install/update instructions, and system-prompt documentation references to `shuvpi`.
- [x] Update `packages/coding-agent/src/core/system-prompt.ts` so the model-facing harness identity is exclusively `shuvpi`.

## Phase 4: Tests, examples, scripts, and workflows

- [x] Rename test inputs, expected package names, paths, env vars, temp prefixes, fixtures created at runtime, and test descriptions to `shuvpi` while leaving frozen JSONL fixtures unchanged.
- [x] Rename example package names, extension manifest keys, imports, paths, and prose to `shuvpi`.
- [x] Rename `pi-test.sh` / `pi-test.ps1` to `shuvpi-test.sh` / `shuvpi-test.ps1` and update every active reference.
- [x] Update `.github/workflows/issue-analysis.yml` environment names, temporary paths, install commands, and fork-facing output; preserve the external `pi.dev` share-viewer URL exception.
- [x] Update developer/support scripts and active artifact names (`pi-browser-smoke`, `pi-extensions`, session-stat defaults, local-release wrappers, archives) to `shuvpi`.

## Phase 5: Documentation and changelogs

- [x] Rebrand active root/package READMEs, package docs, examples, `AGENTS.md`, and `CONTRIBUTING.md` to `shuvpi`, including commands, config paths, package names, and source-run instructions.
- [x] Replace the upstream Pi logo/site framing in the root README with fork-owned `shuvpi` text while retaining clearly labeled upstream documentation/provenance links where still useful.
- [x] Add concise `[Unreleased]` entries to affected package changelogs without modifying released sections.
- [x] Document that existing `~/.pi` data is not automatically migrated and provide explicit manual copy/move guidance.

## Phase 6: Dependency metadata

- [x] Refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts` after manifest/package-name changes.
- [x] Regenerate the four checked-in standalone example lockfiles with `npm install --package-lock-only --ignore-scripts --workspaces=false` so their package identities and exact dependency ranges match the renamed manifests.
- [x] Regenerate `packages/coding-agent/npm-shrinkwrap.json` with `node scripts/generate-coding-agent-shrinkwrap.mjs`.
- [x] Regenerate `packages/coding-agent/install-lock/package-lock.json` with `node scripts/generate-coding-agent-install-lock.mjs`.
- [x] Review all dependency-metadata diffs for only the intended namespace/package changes and generated resolution updates.

## Phase 7: Validation and local delivery

- [x] Run every directly modified test file with its package-specific supported runner and iterate until passing.
- [x] Run `npm run check` with full output and fix all errors, warnings, and informational failures.
- [x] Run final active-surface grep checks proving no `shuvcode`, `@shuv1337/pi*`, product-owned `PI_*`, `.pi`, `piConfig`, `PiManifest`, `dist/pi`, `pi-test.*`, or active `pi` command branding remains outside documented exceptions.
- [x] Build only the coding-agent package as required for local executable delivery (not the prohibited root `npm run build`).
- [x] Relink/install the rebuilt local CLI under `shuvpi`, remove stale fork-owned `shuvcode`/`pi` links only when their ownership is verified, and preserve the resurrected OpenCode `shuvcode` installation.
- [x] Smoke-check `command -v shuvpi`, `shuvpi --version`, `shuvpi --help`, and `shuvpi --list-models`; confirm `shuvcode` still resolves to the OpenCode fork and native upstream `pi` is not overwritten.

## Completion criteria

- [x] All plan tasks are checked off or have an explicit documented exception.
- [x] `implementation-notes.html` records decisions, deviations, and validation evidence.
- [x] The worktree contains only this goal's intended changes plus any clearly identified pre-existing concurrent work.
- [x] The active goal is marked complete only after the full rebrand, validation, and local delivery all succeed.
