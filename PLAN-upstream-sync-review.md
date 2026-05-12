# Upstream Sync Review Plan (revised)

## Context

This fork diverged from `badlogic/pi-mono` at:

- `f829f808` — merge base between this branch and `upstream/main`

Current branch state at review time:

- Local branch: `pi-update-0.70.6`
- Local head: `c7c1feb2` — `fix: add GPT-5.5 support`
- Upstream head: `156a9052` — `chore: approve contributor technocidal`
- Upstream distance: 361 commits ahead of local branch
- Fork-only distance: 17 commits ahead of upstream
- Latest upstream tag observed: `v0.70.6`

The goal is a **merge-then-revert sync** (the previous draft called this a "reverse cherry-pick style sync" — that name was misleading; the mechanism is a single bulk merge followed by a curated revert layer):

1. Accept upstream wholesale via a real merge.
2. Preserve fork-specific behavior and branding through targeted conflict resolution and post-merge reverts.
3. Neutralize a curated denylist of upstream commits introducing unwanted policy, telemetry, update, or deletion behavior.
4. Validate with the repo check gate.

The end state should be a small, reviewable diff against `upstream/main` where every fork policy decision survives as an explicit retained delta.

## Open Decisions — resolved up front

The previous draft left five questions for the maintainer. These materially change the revert set and must be answered before Phase 2 starts; each is now resolved (revisit if intent changes):

1. **Install/update telemetry** — **remove entirely.** Fork already removed the Anthropic nag (`97313aaf`); a "disabled-by-default setting" still ships dead code we don't want.
2. **OpenRouter / Cloudflare attribution headers** — **remove entirely.** Same reasoning. Provider functionality is preserved without attribution headers.
3. **Self-update command** — **disabled.** Fork ships from a private install path; no `pi.dev` endpoint should be wired in.
4. **Post-sync version** — **align all workspace packages to `0.70.6`** to match the upstream tag the branch name implies, then continue fork-side patch bumps from there. Lockstep applies across `agent`, `ai`, `coding-agent`, `mom`, `pods`, `tui`, and `web-ui`, including internal `@mariozechner/pi-*` dependency ranges and `package-lock.json`.
5. **Upstream docs** — accept upstream docs in Phase 1 with rebrand edits inline; defer a comprehensive doc pass to a separate change.

## Pre-flight Setup

Before any merge work begins:

```bash
# 1. Confirm HEAD is the intended fork head, then tag it so rollback is possible.
git rev-parse HEAD
# Expected today: c7c1feb260ba60367ae2a7b776c75ec6d6b44dcd
git tag pre-070-sync HEAD
git push origin pre-070-sync

# 2. Work in a separate branch worktree so the current checked-out
#    pi-update-0.70.6 branch is not reused by two worktrees.
git worktree add -b pi-update-0.70.6-sync ../pi-mono-070-sync pi-update-0.70.6
cd ../pi-mono-070-sync

# Alternative if no branch checkpoint commits are desired:
# git worktree add --detach ../pi-mono-070-sync pi-update-0.70.6
```

Rollback commands are listed later and must be run only inside this dedicated sync worktree after confirming it contains no unrelated work.

## Fork-Only Work To Preserve

These local commits are not in upstream and should be preserved unless explicitly superseded:

- `afc040a9` — runtime model registration
- `ebf70336` — web-ui OpenAI-compatible custom provider discovery
- `1cdac739` — favorite model pinning in selector
- `a8d77f31` — merge stored and discovered custom models
- `f1cb8264` — preserve custom provider model definitions
- `3d79f8a2` — granular web-ui subpath exports
- `365b3696` — local model registry / provider updates
- `6c346bd1` — rebrand pi to shuvcode in system prompt
- `b0c6c90a` — model registry update and suggester state ignore
- `1f0f5fed` — model catalog regeneration after upstream rebase
- `01539111` — model catalog regeneration after v0.66.1 rebase
- `97313aaf` — remove Anthropic nag
- `09648762` — dependency security alert fixes
- `ca1bedd2` — Claude Opus 4.7 support across providers
- `c644c753` — fast-mode / rename planning and implementation snapshot
- `8843d5fd` — GPT-5.5 Codex model
- `c7c1feb2` — GPT-5.5 support follow-up

Some of this overlaps upstream now, especially GPT-5.5, Claude Opus 4.7, generated models, dependency updates, and provider logic. Conflict resolution should keep upstream improvements where they supersede local patches, while preserving fork-specific custom-provider and branding behavior.

## Exclusion Set (Phase 2 reverts)

The following upstream commits/areas are reverted or neutralized after the bulk merge.

### 1. Telemetry And Attribution

Reverted commits:

- `7371c30c` — install telemetry ping controls
- `62c1c403` — OpenRouter attribution headers
- `fbb5eed1` — Cloudflare attribution headers gated by telemetry

Files arriving from upstream that need to be **deleted post-merge** (they do not exist on the local branch today; they enter the tree as part of the merge):

- `packages/coding-agent/src/core/telemetry.ts` — delete
- `packages/coding-agent/src/utils/pi-user-agent.ts` — delete
- `packages/coding-agent/test/sdk-openrouter-attribution.test.ts` — delete; it validates behavior the fork rejects
- `packages/coding-agent/test/pi-user-agent.test.ts` — delete if only needed by deleted `pi-user-agent.ts`

Files arriving with telemetry hooks that need their hooks removed but the file kept:

- `packages/coding-agent/src/core/sdk.ts` — strip telemetry imports/calls and attribution header injection (`HTTP-Referer: https://pi.dev`, `X-Title`, related `extraHeaders` defaults). Preserve provider functionality and user-supplied headers.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — strip telemetry-side wiring, install/update ping fetches, and any `getPiUserAgent()` use.
- `packages/coding-agent/src/core/settings-manager.ts` — remove `enableInstallTelemetry` setting schema/state/getter/setter.
- `packages/coding-agent/src/modes/interactive/components/settings-selector.ts` — remove the install telemetry setting row, config field, and mutation branch.
- `packages/coding-agent/src/cli/args.ts` — remove `PI_TELEMETRY` help text.
- `packages/coding-agent/README.md`, `packages/coding-agent/docs/settings.md`, `packages/coding-agent/docs/usage.md`, `packages/coding-agent/CHANGELOG.md`, `packages/ai/CHANGELOG.md` — strip install telemetry / attribution mentions while preserving valid changelog structure.

Decision: provider functionality preserved; no outbound telemetry or attribution headers as fork default.

### 2. pi.dev Update Checks And Self-Update Flow

Reverted commits:

- `dcf26516` — built-in update command
- `9848b314` — Windows self-update fix
- `c745efc0` — update check against `pi.dev`

Files arriving from upstream that need to be deleted post-merge (do not exist locally today):

- `packages/coding-agent/src/utils/version-check.ts` — delete
- `packages/coding-agent/test/version-check.test.ts` — delete; it imports deleted update-check utilities

Files arriving with update/self-update wiring that need wiring stripped:

- `packages/coding-agent/src/package-manager-cli.ts` — keep package extension update behavior, but remove all self-update support: `self`/`pi` positional targets, `--self`, `UpdateTarget` branches for self, `canSelfUpdate()`, `runSelfUpdate()`, `getLatestPiVersion()`, latest-version comparisons, and self-update-specific help/errors.
- `packages/coding-agent/src/cli/args.ts` — restore update help to package/extension semantics only; remove `update [source|self|pi]` wording.
- `packages/coding-agent/src/config.ts` — remove self-update-only constants or platform handling introduced for updater support if no longer referenced.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — remove startup version-check wiring and any `checkForNewPiVersion()` / `getPiUserAgent()` references.
- `packages/coding-agent/README.md`, `packages/coding-agent/docs/packages.md`, `packages/coding-agent/CHANGELOG.md` — strip pi.dev update/self-update docs and changelog entries.

Decision (binary, no "useful bits if separable" yak shave): drop all upstream `pi.dev`-coupled update logic. If a fork-specific update channel is wanted later, implement it as a separate change against fork infrastructure.

### 3. Contribution Gate / OSS Weekend Replacement

Reverted commits:

- `50ce1b0f` — enable OSS weekend
- `d62d2217` — replace OSS weekend with permanent contribution gate
- `b38e546e` — label weekend issue closures
- `05f79b08` — issue triage policy docs
- contributor approval list churn commits

Files arriving from upstream that need to be deleted post-merge (do not exist locally):

- `.github/workflows/issue-gate.yml` — delete

Existing local files that must **not** be overwritten by the merge (verified to exist locally):

- `.github/APPROVED_CONTRIBUTORS`
- `.github/workflows/pr-gate.yml`
- `.github/workflows/approve-contributor.yml`
- `.github/workflows/openclaw-gate.yml`
- `.github/ISSUE_TEMPLATE/*`
- `CONTRIBUTING.md`
- README policy sections
- `scripts/oss-weekend.mjs`

Decision: the operation is "do not let upstream churn overwrite the fork's existing policy files," not a blanket revert. During conflict resolution, take fork side for every file in this group.

### 4. Upstream Branding Changes

Reverted commits:

- `df84e3d2` — `feat(branding): corporate said we're professionals` (README/CHANGELOG only)

**Accepted (was previously flagged "review carefully"):**

- `de8c9475` — `route hardcoded pi branding through APP_NAME` — **accept upstream.** Reading the commit body: it routes pi branding through `APP_NAME` / `CONFIG_DIR_NAME` / `APP_TITLE` extension points. This is the rebrand seam the fork actually wants. Reverting it would force re-rebranding at source every time upstream touches those sites. Action: accept upstream and configure the env values where appropriate.

Decision: preserve fork's `shuvcode` system prompt and user-facing identity; accept code-level branding configurability as a long-term win.

### 5. Local `.pi` Extension Deletions

Reverted commits:

- `e1d95538` — remove `.pi/extensions/diff.ts`
- `c7a487cd` — remove `.pi/extensions/files.ts`

Verification step (the previous plan missed this): both extensions import `ExtensionAPI`, `DynamicBorder`, and `matchesKey` from `@mariozechner/pi-coding-agent`. After Phase 2 restores the files, run `npm run check` and confirm both still type-check against the v0.70.6 extension API. If either signature changed, port the call sites; do not silently drop the extensions.

Decision: keep `diff.ts` and `files.ts`. Re-evaluate as a separate cleanup.

## Upstream Work Expected To Accept

Most upstream commits should be accepted, including:

- TypeBox v1 migration and extension compatibility work
- AI provider fixes and model compatibility updates
- Anthropic, OpenAI, Bedrock, Mistral, DeepSeek, Cloudflare Workers AI, Fireworks, Azure, and Google provider improvements
- TUI input handling fixes, terminal progress configurability, OSC/hyperlink behavior, Thai width handling, keybinding fixes
- coding-agent session, compaction, export HTML, resource loader, extension, settings, package manager, and tool fixes
- docs reorganizations that do not conflict with fork branding or policy
- security/dependency updates where compatible
- release/version bump changes needed to align package metadata with accepted upstream code
- `de8c9475` `APP_NAME` refactor (see §4 above)

## Conflict Forecast (corrected)

A dry `git merge-tree --write-tree --no-messages --name-only HEAD upstream/main` reports **16 content conflicts** today:

- `package.json`
- `package-lock.json`
- `packages/ai/CHANGELOG.md`
- `packages/ai/scripts/generate-models.ts`
- `packages/ai/src/models.generated.ts`
- `packages/ai/src/models.ts`
- `packages/ai/src/providers/amazon-bedrock.ts`
- `packages/ai/src/providers/anthropic.ts`
- `packages/ai/src/providers/openai-completions.ts`
- `packages/ai/src/providers/openai-responses.ts`
- `packages/coding-agent/CHANGELOG.md`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/model-resolver.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/coding-agent/test/model-resolver.test.ts`
- `packages/web-ui/CHANGELOG.md`

Auto-merge watch list (important files that may not have conflict markers but still need manual review because they carry denylist, branding, or fork-policy behavior):

- `packages/ai/src/providers/openai-codex-responses.ts` — provider behavior touched upstream; verify GPT-5.5 Codex behavior survives.
- `packages/coding-agent/examples/extensions/sandbox/package-lock.json` — likely safe to accept upstream verbatim.
- `packages/coding-agent/src/core/sdk.ts` — telemetry / attribution hooks land here; strip per §1.
- `packages/coding-agent/src/core/settings-manager.ts` — install telemetry setting lands here; strip per §1.
- `packages/coding-agent/src/modes/interactive/components/settings-selector.ts` — install telemetry UI lands here; strip per §1.
- `packages/coding-agent/src/package-manager-cli.ts` — self-update and pi.dev latest-version logic land here; strip per §2.
- `packages/coding-agent/src/cli/args.ts` — telemetry and self-update help text lands here; strip per §1/§2.
- `packages/coding-agent/src/config.ts` — `APP_NAME` refactor and self-update support both touch config; accept branding seams, remove updater-only constants if unused.
- `packages/coding-agent/src/core/slash-commands.ts` — `de8c9475` touches `/quit`; prefer upstream `APP_NAME` style but spot-check user-facing branding.
- `packages/coding-agent/src/core/system-prompt.ts` — **the shuvcode rebrand lives here.** Preserve fork wording; verify post-merge that the system-prompt body still says `shuvcode`.
- `packages/web-ui/package.json` — lockstep version / export behavior.
- `.github/**`, `CONTRIBUTING.md`, `README.md`, `scripts/oss-weekend.mjs` — preserve fork contribution policy and OSS weekend behavior.

These conflicts are expected because local fork work touched the same model/provider/session/branding surfaces that upstream changed heavily between `v0.66.1` and `v0.70.6`.

## Implementation Strategy

Two-phase merge-then-revert. An intermediate commit at the Phase 1 / Phase 2 boundary is useful for validation and bisectability, but only create checkpoint commits if the maintainer has explicitly approved commits for this sync. Otherwise, pause and ask before each commit point.

### Phase 1: Bulk Import

1. From the worktree (`../pi-mono-070-sync`), confirm clean tree.
2. Merge `upstream/main` into the branch (`git merge upstream/main`).
3. Resolve conflicts. Per-file rules:
   - **Generic upstream improvements (providers, TUI fixes, session work, extension API):** prefer upstream.
   - **Custom provider discovery, runtime model registration, web-ui selector, web-ui custom-model persistence:** prefer fork.
   - **Branding (`system-prompt.ts`):** prefer fork; preserve shuvcode strings.
   - **Workflow files in §3 group:** prefer fork.
   - **`.pi/extensions/{diff,files}.ts`:** these were deleted upstream; keep as-is (will be restored when Phase 2 reverts the deletion commits).
   - **`generate-models.ts`:** prefer upstream version of the script. After all conflicts resolve, regenerate `models.generated.ts` (next step).
4. If checkpoint commits have been explicitly approved, commit Phase 1 (`feat: bulk import upstream/main v0.70.6`) with a conflict-resolution body (see §Resolution Rules). If commits have not been approved, leave the resolved merge staged/uncommitted and ask before committing.
5. Run `npm run check`. Fix all errors/warnings/infos before Phase 2.

### Phase 1.5: Generated Models Reconciliation

`generate-models.ts` is itself a conflict file. Resolution policy: take upstream's generator, then verify fork-only model entries survive regen.

```bash
# Regenerate from upstream's script.
cd packages/ai && npm run generate-models   # or whatever the script entry is

# Verify fork-only models did not silently drop.
rg 'opus-4\.7|gpt-5\.5|gpt-5-5-codex' src/models.generated.ts
```

If fork-only entries are missing after regen, port them into `generate-models.ts` (the source of truth for the catalog) rather than re-hand-editing the generated file. If checkpoint commits have been explicitly approved, commit as `chore(ai): regenerate model catalog after v0.70.6 sync`; otherwise ask before committing.

### Phase 2: Denylist Reversal

After Phase 1+1.5 are resolved (and checkpoint commits are created only if explicitly approved) and `npm run check` is clean:

1. Delete arriving telemetry/update files and tests (§1, §2 file lists): `telemetry.ts`, `pi-user-agent.ts`, `version-check.ts`, `sdk-openrouter-attribution.test.ts`, `pi-user-agent.test.ts`, and `version-check.test.ts`.
2. Strip telemetry/update wiring from all concrete surfaces listed in §1 and §2 (`sdk.ts`, `interactive-mode.ts`, `settings-manager.ts`, `settings-selector.ts`, `package-manager-cli.ts`, `cli/args.ts`, docs, and changelogs).
3. Restore `.pi/extensions/diff.ts` and `.pi/extensions/files.ts` from `pre-070-sync` with a path-limited restore: `git restore --source=pre-070-sync -- .pi/extensions/diff.ts .pi/extensions/files.ts`.
4. Confirm fork branding survived in `system-prompt.ts`; spot-check `slash-commands.ts`, `config.ts`, and `package.json` for any unwanted user-facing pi/shuvcode regressions. Decide explicitly whether `packages/coding-agent/package.json` should keep `piConfig.name: "pi"` / `.pi` or switch to fork-specific defaults.
5. Revert `df84e3d2` README/CHANGELOG branding via `git revert --no-commit df84e3d2` (resolve any conflict by re-applying fork wording). Do this only in the dedicated sync worktree.
6. Confirm `.github/` workflow files, `CONTRIBUTING.md`, and `scripts/oss-weekend.mjs` match local pre-merge policy intent; restore from `pre-070-sync` with path-limited `git restore --source=pre-070-sync -- <path>` if any drifted.
7. Lockstep bump: verify **all workspace packages** are at `0.70.6`, not only conflicted packages: `packages/{agent,ai,coding-agent,mom,pods,tui,web-ui}/package.json`. Also update internal `@mariozechner/pi-*` dependency ranges to `^0.70.6` where appropriate and refresh `package-lock.json` via `npm install`.
8. If checkpoint commits have been explicitly approved, commit as `chore: reverse upstream denylist (telemetry, update, contribution gate, branding)`. If not approved, ask before committing.

### Phase 3: Validation

1. `npm run check` — full output, fix all errors/warnings/infos.
2. Run targeted tests only for test files actually created or modified, from the relevant package root. Do **not** run `npm test`, `npm run build`, or `npm run dev`.
   - `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/model-resolver.test.ts`
   - If interactive-mode tests were touched: `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/<specific-interactive-mode-test>.test.ts`
   - If AI provider tests were touched: `cd packages/ai && npx tsx ../../node_modules/vitest/dist/cli.js --run test/<specific-provider-test>.test.ts`
3. Type-check `.pi/extensions/{diff,files}.ts` against the new extension API (`npm run check` covers this; fix API drift rather than dropping the extensions).
4. Run final denylist greps; expected result is no remaining telemetry/update implementation references except intentional docs/history text that has been reviewed:
   ```bash
   rg 'pi\.dev/api|PI_TELEMETRY|enableInstallTelemetry|HTTP-Referer.*pi\.dev' packages/coding-agent/src packages/coding-agent/test
   rg 'version-check|pi-user-agent|telemetry' packages/coding-agent/src packages/coding-agent/test
   ```
5. Final review: `git diff upstream/main --stat` should show a small, reviewable surface limited to the fork's intentional retained deltas.

## Resolution Rules (per-hunk)

When resolving conflicts, annotate non-trivial choices in the Phase 1 commit message body — e.g.:

```
feat: bulk import upstream/main v0.70.6

Conflict resolutions:
- system-prompt.ts: kept fork (shuvcode rebrand)
- model-resolver.ts: merged — kept fork's runtime model registration, took
  upstream's provider lookup refactor
- generate-models.ts: took upstream; fork models verified post-regen
- .github/workflows/pr-gate.yml: kept fork
...
```

Standing rules:

- Prefer upstream implementation for generic bug fixes and provider protocol compatibility.
- Prefer fork implementation for custom provider discovery, runtime model registration, web-ui model persistence, and shuvcode-specific identity.
- For generated model files, prefer regenerating once after conflict resolution rather than hand-merging large generated blocks.
- For changelogs, keep valid `[Unreleased]` structure and avoid editing released sections.
- For package versions, lockstep across packages at `0.70.6`.
- Do not preserve backward compatibility unless explicitly requested.
- Do not remove intentional local functionality without review.

## Rollback Plan

If validation in Phase 3 fails irrecoverably, prefer abandoning the dedicated sync worktree:

```bash
cd ..
git worktree remove pi-mono-070-sync
```

If the worktree must be reset instead, first confirm you are inside the dedicated sync worktree and that it contains no unrelated work. Then, and only then:

```bash
git reset --hard pre-070-sync
```

The original `pi-update-0.70.6` branch checkout is untouched throughout as long as all destructive rollback commands are limited to the dedicated sync worktree.

## Validation Plan

After code changes:

1. Run `npm run check` from repo root.
2. Capture full output, not a tail.
3. Fix all errors, warnings, and infos.
4. If any test file is created or modified, run that specific test file from its package root using `npx tsx ../../node_modules/vitest/dist/cli.js --run <test-file>`.
5. Do not run `npm run dev`, `npm run build`, `npm test`, or broad wildcard test commands.

Useful targeted tests (only if those files are touched):

- `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/model-resolver.test.ts`
- `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/<specific-interactive-mode-test>.test.ts`
- `cd packages/ai && npx tsx ../../node_modules/vitest/dist/cli.js --run test/<specific-provider-or-model-test>.test.ts`
- `cd packages/web-ui && npx tsx ../../node_modules/vitest/dist/cli.js --run <specific-web-ui-test>` if selector/provider UI tests exist and were touched

## Review Checklist

- [x] Confirm exclusion set with maintainer (resolved in §Open Decisions).
- [x] Confirm whether upstream contribution gates should remain excluded (yes).
- [x] Confirm whether `.pi/extensions/diff.ts` and `.pi/extensions/files.ts` are still wanted (yes).
- [x] Confirm fork update-check behavior (disabled).
- [x] Confirm post-sync version (lockstep `0.70.6`).
- [x] Tag `pre-070-sync` on verified fork `HEAD` before merging.
- [x] Create a separate sync worktree via a new branch (`pi-update-0.70.6-sync`) or detached worktree; do not attempt to check out `pi-update-0.70.6` in two worktrees.
- [x] Confirm whether checkpoint commits are explicitly approved before committing Phase 1/Phase 2.
- [x] Add `system-prompt.ts`, `slash-commands.ts`, `sdk.ts`, `settings-manager.ts`, `settings-selector.ts`, `package-manager-cli.ts`, `cli/args.ts`, `config.ts`, `openai-codex-responses.ts`, and `web-ui/package.json` to active conflict/watch list during merge.
- [x] Resolve merge conflicts.
- [x] Reconcile generated model catalog; verify fork-only models survived regen.
- [x] Verify `.pi/extensions/{diff,files}.ts` type-check against v0.70.6 extension API after restoration.
- [x] Preserve web-ui custom provider and favorite model behavior.
- [x] Preserve shuvcode system prompt behavior (assert string in system-prompt.ts post-merge).
- [x] Lockstep bump all workspace packages and internal `@mariozechner/pi-*` dependency ranges to `0.70.6` / `^0.70.6` as appropriate; refresh `package-lock.json`.
- [x] Run `npm run check`.
- [x] Run only targeted tests for modified/created test files from package roots.
- [x] Run final telemetry/update denylist `rg` checks.
- [x] Review final diff for accidental upstream policy/telemetry imports.
- [x] Commit only if explicitly requested or already approved for this sync.
