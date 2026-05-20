# Upstream Merge Plan: pi-mono v0.70.6 → v0.75.4

> **Status:** Reviewed twice. Pre-flight decisions baked in. Ready for implementation after cleaning the worktree.
> **Scope:** Merge 378 upstream commits from `pi` v0.70.6 → v0.75.4 into `pi-mono` fork.
> **Risk Level:** CRITICAL — naive direct merge shows 272 conflicted files and 2,295 conflict markers; implementation requires ancestry bridge plus structural restores via `git checkout HEAD --` (not `--ours`).

---

## 1. Executive Summary

The fork (`pi-mono`) is **5 minor versions behind** upstream (`pi`). Upstream has made 378 commits between `v0.70.6` and `v0.75.4`. However, the prior `v0.70.6` sync was committed as a squashed/synthetic merge and did **not** record `v0.70.6` as a Git parent. As a result, a direct `main...v0.75.4` comparison currently reports `main` as 20 commits ahead and 718 commits behind. The merge branch must first record the already-applied `v0.70.6` ancestry with an `ours` merge, then merge the exact `v0.75.4` tag.

A direct merge attempt without the ancestry bridge produces **272 conflicted files with 2,295 conflict markers** and replays already-synced upstream history. After the ancestry bridge, the conflict set is materially smaller but still requires manual semantic resolution.

**Critical architectural divergences:**
- Upstream **removed** `packages/web-ui/`, `packages/mom/`, `packages/pods/` — the fork added/keeps all three
- Upstream **removed** `packages/coding-agent/examples/extensions/custom-provider-qwen-cli/` — fork added it
- Upstream **added** dependency hardening (shrinkwrap, pinned deps, npm age gate) — fork has looser dependency management
- Upstream **retained Husky** but changed dependency hardening and pinned dependency posture
- Fork has **custom provider/model additions** (GPT-5.5, Claude Opus 4.7, Fireworks Fire Pass) that upstream lacks
- Fork has **web-ui enhancements** (custom provider discovery, model pinning, model merging) that upstream removed the entire package for

**Recommendation:** Use an ancestry bridge, then perform one exact-tag merge on a staging branch. Resolve conflicts package-by-package as an ordering discipline, not as separate Git merges. Restore fork-owned packages wholesale before staging anything — using `git checkout HEAD -- <path>`, **not** `git checkout --ours --`, because most fork-owned files in upstream-deleted packages are unmodified since v0.70.6 and Git will resolve them as clean deletes (no stage entries, `--ours` would fail silently).

---

## 1.5. Pre-flight Decisions (REQUIRED before Phase 1)

These decisions change the **mechanics** of conflict resolution, not just style. Lock them in before starting the merge. Defaults below are recommended and reflected in the rest of this plan; deviate only with explicit justification.

| # | Decision | Default | Rationale |
|---|----------|---------|-----------|
| D1 | **Package namespace** (`@mariozechner/*` vs `@earendil-works/*`) | **Keep `@mariozechner/*`** | Fork has 290 import sites for `@mariozechner/pi-*`. Switching would mean rewriting every import in every package plus the published npm names. Treat this as a separate, intentional rebrand if ever desired — not collateral damage of this merge. When resolving `package.json` conflicts, always keep the fork's `"name": "@mariozechner/pi-*"` line. |
| D2 | **Node engine** (`>=20.0.0` vs `>=22.19.0`) | **Adopt upstream `>=22.19.0`** | Upstream pins it and several v0.75.x features rely on Node 22 APIs. Fork dev machines and CI need to run Node 22+ after this merge. If any deployment target is stuck on Node 20, fail loudly here. |
| D3 | **Root version field** (fork `0.70.6` vs upstream `0.0.3`) | **Adopt upstream `0.0.3`** | Root `version` is decorative — workspace packages carry their own versions. Upstream's `0.0.3` is the project convention. Set the root to `0.0.3`; let `sync-versions.js` keep workspace packages at their independent versions (`0.75.4` after this merge). |
| D4 | **Google Gemini CLI provider & OAuth helpers** | **Preserve** (`packages/ai/src/providers/google-gemini-cli.ts`, `utils/oauth/google-gemini-cli.ts`, `utils/oauth/google-antigravity.ts`, all associated tests) | Fork has 4 active tests for this provider and no replacement has been identified. Restore via `git checkout HEAD --` in Task 1.4. Revisit only if/when upstream ships an equivalent path. |
| D5 | **Dependency hardening** (pinned deps, shrinkwrap, npm age gate, `--ignore-scripts`) | **Adopt upstream's posture** | Security wins outweigh inconvenience. Adopt `check:pinned-deps`, `check:shrinkwrap`, `check:ts-imports`, `shrinkwrap:coding-agent`, `release:local`. See Task 3.1 / 3.1.5 for the dependency-tightening sweep this forces on fork-only deps. |
| D6 | **Husky** | **Keep** (no change) | Upstream v0.75.4 still ships `.husky/pre-commit` and pins `husky`. Fork already has them. This is not actually an open question. |
| D7 | **Image generation API** (`packages/ai/src/images.ts`, image model catalog, image providers introduced upstream) | **Adopt upstream** | Pull it in as-is. Custom providers can integrate with it in a follow-up PR; do not block the merge on integration work. |
| D8 | **TypeScript erasable-syntax / `.js` import extensions** | **Adopt upstream** | Required for upstream's `check:ts-imports` to pass. Fork code that violates this will need mechanical fixups during Phase 2 (expect 20-60 minutes of import rewrites). |
| D9 | **Workspaces array** | **Union of fork + upstream** | Take fork's `web-ui`, `mom`, `pods`, `web-ui/example`, `custom-provider-qwen-cli` entries AND upstream's new `custom-provider-anthropic`, `custom-provider-gitlab-duo`, `examples/extensions/sandbox`. See Task 2.1. |

Record any deviations from these defaults in the merge commit body so reviewers can audit the choices.

---

## 2. Current State Analysis

### 2.1 Version Gap

| Repository | Version | Last Sync Commit |
|-----------|---------|-----------------|
| `pi` (upstream) | v0.75.4 | `3533843d` |
| `pi-mono` (fork) | v0.70.6 + 19 fork commits | `e974ce51` |

**True tag delta:** 378 upstream commits from `v0.70.6..v0.75.4`.

**Current Git ancestry delta:** `main..v0.75.4` reports 718 commits because `e974ce51` did not record `v0.70.6` as an upstream parent. This must be fixed on the merge branch with:

```bash
git merge -s ours v0.70.6 --no-ff -m "chore: record upstream v0.70.6 ancestry"
```

After that bridge commit, `git merge v0.75.4 --no-commit --no-ff` operates from the intended v0.70.6 base instead of replaying already-synced history.

### 2.2 Fork-Unique Commits (since v0.70.6)

```
e974ce51 chore: sync upstream v0.70.6 (merge + policy denylist revert) (#222)
ad0a9105 feat(ai): add native Fireworks Fire Pass provider with Kimi K2.6 Turbo
9fc419ae updates
c7c1feb2 fix: add GPT-5.5 support
8843d5fd feat(ai): add GPT-5.5 Codex model
c644c753 chore: save current changes
ca1bedd2 feat(ai): add Claude Opus 4.7 support across providers
09648762 fix(deps): resolve all 7 dependabot security alerts
97313aaf removing anthropic nag
01539111 chore(ai): regenerate model catalog after v0.66.1 rebase
1f0f5fed chore(ai): regenerate model catalog after upstream rebase
b0c6c90a chore: update model registry and ignore suggester state
6c346bd1 refactor: rebrand pi to shuvcode in system prompt
365b3696 updates
3d79f8a2 chore(web-ui): add granular subpath exports
f1cb8264 fix(web-ui): preserve custom provider model definitions
a8d77f31 fix(web-ui): merge stored and discovered custom models
1cdac739 feat(web-ui): pin favorite models in selector
ebf70336 feat(web-ui): discover openai-compatible custom providers
afc040a9 feat: allow runtime model registration
```

### 2.3 Fork-Unique Files (added, not in upstream)

**New packages (upstream deleted these, fork kept/created):**
- `packages/mom/` — Full package: sandbox runtime, Slack bot, artifacts server
- `packages/pods/` — Full package: model pod management, SSH provisioning
- `packages/web-ui/` — Full package: web-based UI (upstream removed this entirely)

**New extensions (upstream lacks):**
- `packages/coding-agent/examples/extensions/custom-provider-qwen-cli/`
- `packages/coding-agent/examples/extensions/antigravity-image-gen.ts`

**New providers (upstream lacks):**
- `packages/ai/src/providers/google-gemini-cli.ts`
- `packages/ai/src/providers/proxx-debug.ts`
- `packages/ai/src/utils/oauth/google-antigravity.ts`
- `packages/ai/src/utils/oauth/google-gemini-cli.ts`

**New tests:**
- `packages/ai/test/google-gemini-cli-*.test.ts`
- `packages/ai/test/google-tool-call-missing-args.test.ts`
- `packages/coding-agent/test/fast-mode.test.ts`
- `packages/coding-agent/test/compaction-thinking-model.test.ts`

**Fork infrastructure:**
- `HANDOFF.md`
- `PLAN-fast-mode-gpt-5.4.md`
- `PLAN-rename-pi-to-shuv.md`
- `.github/oss-weekend.json`
- `.github/APPROVED_CONTRIBUTORS.vacation`
- `.pi/extensions/diff.ts`
- `.pi/extensions/files.ts`

---

## 3. Upstream Changes Since v0.70.6

### 3.1 Major Architectural Changes

| Change | Impact | Files Affected |
|--------|--------|--------------|
| **Removed `web-ui` workspace** | HIGH — Fork actively maintains web-ui | `package.json` workspaces, build scripts, all of `packages/web-ui/` |
| **Removed `mom` and `pods`** | HIGH — Fork has active development here | `package.json` workspaces, build scripts, all of `packages/mom/`, `packages/pods/` |
| **Dependency hardening** | MEDIUM — Fork may want to adopt | New scripts: `check-pinned-deps.mjs`, `generate-coding-agent-shrinkwrap.mjs`, `local-release.mjs` |
| **Husky retained but dependency hardening changed** | LOW — Upstream still has `.husky/pre-commit`, `prepare: "husky"`, and pinned `husky` | Root `package.json`, `.husky/pre-commit` |
| **TS import extensions enforced** | MEDIUM — Code style divergence | `ae9450dc` — all imports now use `.js` extensions |
| **Erasable TypeScript syntax** | MEDIUM — Type-only import changes | `06c6c324` — enforces `import type` syntax |
| **Removed `agent` harness** | MEDIUM — Fork may have harness deps | `packages/agent/src/harness/` deleted, moved to `coding-agent` |
| **Image generation API** | MEDIUM — New `packages/ai/src/images.ts` and related | Fork may want to integrate with its custom providers |
| **Google Gemini CLI provider removed upstream** | MEDIUM — Fork still carries provider and OAuth helper | **CONFLICT:** Treat as modify/delete, not add/add; decide explicitly whether to preserve fork provider |
| **OpenAI Codex responses overhaul** | HIGH — Major provider refactoring | `packages/ai/src/providers/openai-codex-responses.ts` heavily changed |
| **Model catalog regeneration** | HIGH — Fork also regenerates | `packages/ai/src/models.generated.ts` will conflict |

### 3.2 Notable Upstream Commits by Theme

**Security & Dependencies (v0.75.x):**
- `29851d01` — Enforce npm dependency age gate
- `a3ebcd23` — Disable scripts during self-update
- `715c82ce` — Shrinkwrap coding agent release deps
- `ea4eab15` — Pin dependencies and use native TypeScript

**Coding Agent Core:**
- `f4f0ac7a` — Show update notes
- `b9448276` — Stop tool preflight after extension abort
- `c685b273` — Mark retrying agent end events
- `32bcdc97` — Simplify agent session settlement
- `93ecdbea` — Improve subagent parallel summaries

**TUI & Terminal:**
- `f10cf57e` — Improve terminal theme detection
- `47902460` — Set explicit theme text colors
- `7577d3b8` — XML boundaries in default system prompt
- `23b361cf` — Initialize loader before starting indicator

**AI Providers:**
- `2787b601` — Stop defaulting max token request caps
- `7be75bad` — Clamp OpenAI prompt cache keys
- `b8f51957` — Add Xiaomi reasoning replay compat

---

## 4. Conflict Analysis

### 4.1 Conflict Summary

```
Direct merge without ancestry bridge:
  Total conflicted files:      272
  Conflict markers:           2,295
  Content conflicts:          ~230 (CONFLICT content)
  Modify/delete conflicts:      ~25  (CONFLICT modify/delete)
  Add/add conflicts:          ~17  (CONFLICT add/add)

Required implementation merge:
  First add an `ours` ancestry bridge for v0.70.6.
  Then merge the exact v0.75.4 tag.
  Recompute conflict counts from that state before assigning work.
```

The direct-merge numbers are retained only as evidence that the naive path is wrong. They must not be used as the implementation checklist.

### 4.2 Conflict Categories

#### A. Structural Divergences (Modify/Delete + Upstream Deletions)

These are files **upstream deleted** but **fork modified**. Strategy: keep fork versions. This list is not sufficient to preserve the deleted packages because Git only flags files modified by the fork as conflicts; unchanged files in deleted upstream packages are staged as plain deletions.

| File | Reason to Keep Fork |
|------|-------------------|
| `packages/mom/CHANGELOG.md` | Fork actively maintains mom package |
| `packages/mom/docs/new.md` | Fork documentation |
| `packages/mom/package.json` | Fork package config |
| `packages/mom/src/events.ts` | Fork-specific event handling |
| `packages/mom/src/tools/attach.ts` | Fork tool implementation |
| `packages/mom/src/tools/bash.ts` | Fork tool implementation |
| `packages/mom/src/tools/edit.ts` | Fork tool implementation |
| `packages/mom/src/tools/read.ts` | Fork tool implementation |
| `packages/mom/src/tools/write.ts` | Fork tool implementation |
| `packages/pods/package.json` | Fork actively maintains pods package |
| `packages/ai/src/providers/google-gemini-cli.ts` | Fork provider; upstream v0.75.4 deletes it |
| `packages/ai/src/utils/oauth/google-gemini-cli.ts` | Fork OAuth helper; upstream v0.75.4 deletes it |
| `packages/ai/src/utils/oauth/google-antigravity.ts` | Fork OAuth helper; upstream v0.75.4 deletes it |
| `packages/web-ui/CHANGELOG.md` | Fork actively maintains web-ui |
| `packages/web-ui/example/package.json` | Fork web-ui example |
| `packages/web-ui/example/tsconfig.json` | Fork web-ui example |
| `packages/web-ui/package.json` | Fork web-ui package |
| `packages/web-ui/src/components/AgentInterface.ts` | Fork web-ui component |
| `packages/web-ui/src/components/CustomProviderCard.ts` | Fork web-ui custom provider UI |
| `packages/web-ui/src/dialogs/CustomProviderDialog.ts` | Fork web-ui custom provider dialog |
| `packages/web-ui/src/dialogs/ModelSelector.ts` | Fork web-ui model selector |
| `packages/web-ui/src/dialogs/ProvidersModelsTab.ts` | Fork web-ui providers tab |
| `packages/web-ui/src/storage/stores/custom-providers-store.ts` | Fork web-ui storage |
| `packages/web-ui/src/tools/artifacts/artifacts.ts` | Fork web-ui artifacts |
| `packages/web-ui/src/tools/artifacts/SvgArtifact.ts` | Fork web-ui SVG artifact |
| `packages/web-ui/src/tools/extract-document.ts` | Fork web-ui tool |
| `packages/web-ui/src/tools/javascript-repl.ts` | Fork web-ui JS repl |
| `packages/web-ui/src/utils/model-discovery.ts` | Fork web-ui model discovery |
| `packages/web-ui/tsconfig.json` | Fork web-ui config |

**Resolution:** restore whole fork-owned directories from the bridge HEAD tree, not only conflicted files. **Use `git checkout HEAD --`, not `git checkout --ours --`.**

> **Why `HEAD` and not `--ours`:** `packages/web-ui/`, `packages/mom/`, and `packages/pods/` all existed at `v0.70.6`. After the ancestry bridge, the merge base is `v0.70.6` (has them), theirs is `v0.75.4` (deleted them), ours is the bridge HEAD (has them). For files the fork **modified** since `v0.70.6` → modify/delete conflict → stage 2 entry exists → `--ours` works. For files the fork **did not modify** since `v0.70.6` (the bulk of `web-ui/mom/pods`) → Git auto-resolves as a clean delete → **no stage entries** → `git checkout --ours -- <path>` errors with `did not match any file(s) known to git` and the file stays deleted. `git checkout HEAD -- <path>` restores from the bridge tree unconditionally and handles both cases.

```bash
git checkout HEAD -- \
  packages/mom \
  packages/pods \
  packages/web-ui \
  packages/coding-agent/examples/extensions/custom-provider-qwen-cli \
  packages/coding-agent/examples/extensions/antigravity-image-gen.ts \
  packages/ai/src/providers/google-gemini-cli.ts \
  packages/ai/src/providers/proxx-debug.ts \
  packages/ai/src/utils/oauth/google-gemini-cli.ts \
  packages/ai/src/utils/oauth/google-antigravity.ts \
  packages/ai/test/google-gemini-cli-claude-thinking-header.test.ts \
  packages/ai/test/google-gemini-cli-empty-stream.test.ts \
  packages/ai/test/google-gemini-cli-retry-delay.test.ts \
  packages/ai/test/google-tool-call-missing-args.test.ts \
  packages/coding-agent/src/core/fast-mode.ts \
  packages/coding-agent/test/fast-mode.test.ts \
  packages/coding-agent/test/compaction-thinking-model.test.ts \
  .pi/extensions/diff.ts \
  .pi/extensions/files.ts

# Same paths, staged so they survive the merge commit
git add \
  packages/mom \
  packages/pods \
  packages/web-ui \
  packages/coding-agent/examples/extensions/custom-provider-qwen-cli \
  packages/coding-agent/examples/extensions/antigravity-image-gen.ts \
  packages/ai/src/providers/google-gemini-cli.ts \
  packages/ai/src/providers/proxx-debug.ts \
  packages/ai/src/utils/oauth/google-gemini-cli.ts \
  packages/ai/src/utils/oauth/google-antigravity.ts \
  packages/ai/test/google-gemini-cli-claude-thinking-header.test.ts \
  packages/ai/test/google-gemini-cli-empty-stream.test.ts \
  packages/ai/test/google-gemini-cli-retry-delay.test.ts \
  packages/ai/test/google-tool-call-missing-args.test.ts \
  packages/coding-agent/src/core/fast-mode.ts \
  packages/coding-agent/test/fast-mode.test.ts \
  packages/coding-agent/test/compaction-thinking-model.test.ts \
  .pi/extensions/diff.ts \
  .pi/extensions/files.ts
```

Do **not** run `git add -A` at this stage — that would also stage spurious deletions and add/add resolutions before they have been reviewed.

#### B. Add/Add Conflicts and Novel Upstream Files

> **Note:** A prior revision of this plan listed ~16 files as "add/add" conflicts (e.g., `border-status-editor.ts`, `tic-tac-toe.ts`, `auth-guidance.ts`). Verification showed those files already exist in `v0.70.6`, so after the ancestry bridge they are **not** add/add conflicts — they are at worst ordinary content conflicts, and most have no fork-side edits at all. That list has been removed.
>
> **Recompute the real add/add set after the bridge + tag merge by running:**
> ```bash
> # Files added on both sides since v0.70.6 (true add/add)
> git status --porcelain | rg '^AA '
> # All unmerged paths grouped by conflict type
> git status --porcelain | rg '^(AA|UU|DU|UD|AU|UA|DD) '
> ```
> Resolve from there. The list below is the *expected* set of genuinely-new upstream files (not in `v0.70.6`, present in `v0.75.4`) that you should plan to **adopt wholesale** unless they touch fork-customized surfaces.

**Genuinely new upstream additions (adopt from v0.75.4):**

| Path | Notes |
|------|-------|
| `packages/coding-agent/examples/extensions/sandbox/` | New workspace — must also be added to root `workspaces` array (see Task 2.1) |
| `packages/coding-agent/examples/extensions/doom-overlay/` | New example dir |
| `packages/coding-agent/examples/extensions/plan-mode/` | New example dir |
| `packages/coding-agent/examples/extensions/dynamic-resources/` | New example dir |
| `packages/coding-agent/examples/extensions/subagent/` | New example dir |
| `packages/ai/src/images.ts` and image-provider files | New image generation API (decision D7: adopt) |
| `scripts/check-pinned-deps.mjs` | Dependency hardening (decision D5: adopt) |
| `scripts/check-ts-relative-imports.mjs` | TS import-extension enforcement (decision D8: adopt) |
| `scripts/generate-coding-agent-shrinkwrap.mjs` | Shrinkwrap generator (decision D5: adopt) |
| `scripts/local-release.mjs` | Local release flow (decision D5: adopt) |

**Files where both sides made independent edits and need real merging** — to be enumerated only after the merge stops on conflicts and you've run the recompute commands above.

#### C. Content Conflicts — ~230 files

These require line-by-line resolution. Key high-impact files:

**Root & Build:**
- `package.json` — workspaces, scripts, devDependencies diverge
- `package-lock.json` — massive dependency tree divergence
- `tsconfig.json` — compiler options may differ
- `scripts/release.mjs` — release process differences

**packages/ai/ (High Impact):**
- `src/models.generated.ts` — Both regenerated catalogs. Fork has GPT-5.5, Claude Opus 4.7, Fireworks. Upstream has newer base models.
- `src/providers/anthropic.ts` — Fork added Opus 4.7
- `src/providers/openai-codex-responses.ts` — Major upstream refactor
- `src/providers/openai-completions.ts` — Major upstream refactor
- `src/providers/amazon-bedrock.ts` — Upstream Bedrock updates
- `src/providers/mistral.ts` — Upstream Mistral updates
- `src/providers/simple-options.ts` — Upstream changes
- `src/index.ts` — Export list divergence
- `src/types.ts` — Type definitions divergence
- `src/models.ts` — Model type changes

**packages/coding-agent/ (Very High Impact):**
- `package.json` — Dependencies, scripts, version
- `src/core/agent-session.ts` — Major upstream refactoring of session logic
- `src/core/agent-session-runtime.ts` — Runtime event handling changes
- `src/core/agent-session-services.ts` — Services refactoring
- `src/core/extensions/types.ts` — Extension API changes
- `src/core/extensions/loader.ts` — Extension loading changes
- `src/core/extensions/runner.ts` — Extension runner changes
- `src/core/model-registry.ts` — Model registry divergence (fork has custom models)
- `src/core/model-resolver.ts` — Model resolution changes
- `src/core/tools/bash.ts` — Bash tool changes (upstream added incremental output)
- `src/core/tools/read.ts` — Read tool compact rendering (upstream changed)
- `src/core/tools/edit.ts` — Edit tool changes
- `src/core/tools/find.ts` — Find tool changes
- `src/core/tools/grep.ts` — Grep tool changes
- `src/core/tools/ls.ts` — LS tool changes
- `src/core/tools/write.ts` — Write tool changes
- `src/core/tools/index.ts` — Tool export list
- `src/core/system-prompt.ts` — System prompt changes (upstream added XML boundaries)
- `src/core/config.ts` — Config options divergence
- `src/core/sdk.ts` — SDK API changes
- `src/core/skills.ts` — Skills system changes
- `src/modes/interactive/interactive-mode.ts` — TUI mode changes
- `src/cli.ts` — CLI entry changes
- `src/cli/args.ts` — Argument parsing changes
- `src/main.ts` — Main entry changes
- `src/index.ts` — Export list

**packages/tui/ (Medium Impact):**
- `package.json` — Dependencies
- `src/components/editor.ts` — Editor component changes
- `src/components/loader.ts` — Loader changes
- `src/components/markdown.ts` — Markdown rendering changes
- `src/terminal-image.ts` — Terminal image changes
- `src/tui.ts` — Core TUI changes
- `src/index.ts` — Export list

**packages/agent/ (Medium Impact):**
- `package.json` — Dependencies
- `src/agent-loop.ts` — Agent loop changes
- `src/types.ts` — Type changes

---

## 5. Merge Strategy

### 5.1 Strategy: Ancestry Bridge + Exact-Tag Merge + Ordered Resolution

A naive `git merge upstream-pi/main` is **not viable** because it targets an unreleased post-tag commit and uses the wrong merge base. Instead:

**Phase 1: Preparation and ancestry bridge**
1. Clean or stash the current worktree
2. Create `merge/upstream-0.75.4`
3. Record already-applied `v0.70.6` upstream history with `git merge -s ours v0.70.6 --no-ff`
4. Merge the exact target tag: `git merge v0.75.4 --no-commit --no-ff`
5. Restore fork-owned packages and fork-only extension/provider paths wholesale

**Phase 2: Package-by-package conflict resolution order**
1. Resolve root files (`package.json`, config, scripts) enough to support package decisions
2. Resolve `packages/agent/` first (lowest dependency, fewest fork changes)
3. Resolve `packages/tui/` second
4. Resolve `packages/ai/` third (high fork customization)
5. Resolve `packages/coding-agent/` last (highest complexity)
6. Finalize root files (`package-lock.json`, shrinkwrap, build scripts)

This is a resolution order inside one merge, not multiple independent package merges.

**Phase 3: Integration & Testing**
1. Regenerate `package-lock.json` with script execution disabled first
2. Run type checks (`npm run check`)
3. Run tests per package
4. Verify custom providers still work
5. Verify web-ui builds
6. Verify mom/pods build

### 5.2 Rejected Alternatives

**Rebase + cherry-pick** was considered and rejected: the fork's `e974ce51` "sync v0.70.6" commit is itself a squashed merge with no upstream parent, and the model-catalog regeneration commits (`01539111`, `1f0f5fed`, `ad0a9105`) will conflict badly with upstream's regenerated catalog. Rebase offers no clarity advantage and loses the audit trail of the original sync.

**Naive `git merge upstream-pi/main`** was considered and rejected: `upstream-pi/main` currently includes at least one post-v0.75.4 commit, and without the ancestry bridge the merge base resolves to a pre-v0.70.6 point, replaying 718 commits of already-synced history (272 false conflicts, 2,295 false conflict markers).

---

## 6. Detailed Execution Plan

### Phase 1: Preparation (1-2 hours)

#### Task 1.0: Start from a Clean Worktree

Current observed worktree before this revision:
- `packages/ai/src/models.generated.ts` is modified
- `PLAN-upstream-merge-0.75.4.md` is untracked/modified

**Handling the in-flight `models.generated.ts` change:** Task 2.4.2 regenerates this file from scratch by running the fork's model-generation script after taking upstream's version as a starting point. Any in-flight manual edits to `models.generated.ts` will be **discarded** by that step. Stash them only so the worktree is clean, but do not plan to restore the stash later:

```bash
git status --short --branch

# Commit the plan doc so it travels with the merge branch
git add PLAN-upstream-merge-0.75.4.md
git commit -m "docs: add upstream v0.75.4 merge plan"

# Stash the generated file (will be discarded — see Task 2.4.2)
git stash push -m "pre-merge: discard-on-regen models.generated.ts" \
  -- packages/ai/src/models.generated.ts

# Confirm clean
git status --short --branch  # must be empty
```

If `git status` shows any other modifications, deal with them explicitly — do not start the merge with anything dirty.

#### Task 1.1: Create Merge Branch
```bash
git checkout -b merge/upstream-0.75.4
```

#### Task 1.2: Record Prior Upstream Ancestry

The previous `v0.70.6` sync is already applied in content but not in Git ancestry. Record it with an `ours` merge on the merge branch so Git computes the next merge from the right base.

```bash
git merge -s ours v0.70.6 --no-ff -m "chore: record upstream v0.70.6 ancestry"
git rev-list --left-right --count HEAD...v0.75.4
```

Expected after the bridge: the remaining target-side count should align with the `v0.70.6..v0.75.4` range instead of the previous 718-commit ancestry gap.

#### Task 1.3: Start Exact-Tag Merge

Use the release tag, not `upstream-pi/main`, because `upstream-pi/main` currently includes at least one post-v0.75.4 commit.

```bash
git merge v0.75.4 --no-commit --no-ff
```

#### Task 1.4: Restore Fork-Owned Deleted Packages and Providers

Restore fork-owned paths that upstream deleted. **Use `git checkout HEAD -- <path>`, not `git checkout --ours -- <path>`** — see §4.2.A for the full explanation. The short version: `web-ui`, `mom`, and `pods` all existed at v0.70.6; upstream deleted them; for any fork-owned file inside those packages that was *not* modified after v0.70.6, Git resolves the merge as a clean delete with no stage entries, and `--ours` cannot restore it. `HEAD` (the bridge commit's tree) restores unconditionally.

Save this as `scripts/restore-fork-owned.sh` and run it after `git merge v0.75.4 --no-commit --no-ff` stops:

```bash
#!/usr/bin/env bash
# restore-fork-owned.sh — run after `git merge v0.75.4` halts on conflicts.
# Restores every fork-owned path that upstream v0.75.4 deleted or never had.
set -euo pipefail

FORK_OWNED=(
  packages/mom
  packages/pods
  packages/web-ui
  packages/coding-agent/examples/extensions/custom-provider-qwen-cli
  packages/coding-agent/examples/extensions/antigravity-image-gen.ts
  packages/ai/src/providers/google-gemini-cli.ts
  packages/ai/src/providers/proxx-debug.ts
  packages/ai/src/utils/oauth/google-gemini-cli.ts
  packages/ai/src/utils/oauth/google-antigravity.ts
  packages/ai/test/google-gemini-cli-claude-thinking-header.test.ts
  packages/ai/test/google-gemini-cli-empty-stream.test.ts
  packages/ai/test/google-gemini-cli-retry-delay.test.ts
  packages/ai/test/google-tool-call-missing-args.test.ts
  packages/coding-agent/src/core/fast-mode.ts
  packages/coding-agent/test/fast-mode.test.ts
  packages/coding-agent/test/compaction-thinking-model.test.ts
  .pi/extensions/diff.ts
  .pi/extensions/files.ts
)

git checkout HEAD -- "${FORK_OWNED[@]}"
git add -- "${FORK_OWNED[@]}"

# Verification: every restored path must now exist on disk and be tracked.
for path in "${FORK_OWNED[@]}"; do
  if [[ ! -e "$path" ]]; then
    echo "ERROR: $path missing after restore" >&2
    exit 1
  fi
done

echo "Restored ${#FORK_OWNED[@]} fork-owned paths from bridge HEAD."
```

Run it:
```bash
chmod +x scripts/restore-fork-owned.sh
./scripts/restore-fork-owned.sh
```

Do not run `git add -A` until all conflicts are resolved and the verification gate in Task 3.6 passes.

#### Task 1.5: Pre-Review High-Risk Conflicts
Manually compare these files:
- `packages/ai/src/providers/google-gemini-cli.ts` — modify/delete; fork provider vs upstream removal
- `packages/ai/src/utils/oauth/google-gemini-cli.ts` — modify/delete; fork OAuth helper vs upstream removal
- `packages/coding-agent/src/core/auth-guidance.ts`
- `packages/coding-agent/src/core/provider-display-names.ts`

For each:
```bash
git show v0.75.4:packages/ai/src/providers/google-gemini-cli.ts > /tmp/upstream-gemini.ts 2>/dev/null || true
git show HEAD:packages/ai/src/providers/google-gemini-cli.ts > /tmp/fork-gemini.ts
diff -u /tmp/upstream-gemini.ts /tmp/fork-gemini.ts
```

Create merged versions if both have valuable changes.

---

### Phase 2: Package-By-Package Conflict Resolution (9-15 hours)

#### Task 2.1: Root Files (`package.json`, `tsconfig.json`, scripts)

**File: `package.json`** — apply pre-flight decisions from §1.5:

- **Workspaces (D9 — union):** Take the union of fork and upstream entries. Final array:
  ```json
  "workspaces": [
    "packages/*",
    "packages/web-ui/example",
    "packages/coding-agent/examples/extensions/with-deps",
    "packages/coding-agent/examples/extensions/custom-provider-anthropic",
    "packages/coding-agent/examples/extensions/custom-provider-gitlab-duo",
    "packages/coding-agent/examples/extensions/custom-provider-qwen-cli",
    "packages/coding-agent/examples/extensions/sandbox"
  ]
  ```
- **Build script:** Keep fork's (builds tui → ai → agent → coding-agent → mom → web-ui → pods).
- **Dev script:** Keep fork's `concurrently`-based script.
- **Namespace (D1):** Keep `@mariozechner/*` in every workspace `package.json`. Reject any upstream chunk that flips a `"name"` field to `@earendil-works/*`.
- **Node engine (D2):** Adopt upstream `>=22.19.0` in every `"engines"` block.
- **Root `version` (D3):** Adopt upstream `"version": "0.0.3"`. Workspace package versions remain on their own track (will land at `0.75.4` after this merge for upstream-shared packages; fork-owned `mom`/`pods`/`web-ui` stay on their fork track).
- **Adopt upstream's dependency hardening scripts (D5):**
  - `check:pinned-deps`
  - `check:shrinkwrap`
  - `check:ts-imports`
  - `shrinkwrap:coding-agent`
  - `release:local`
  Also adopt the upstream `check` script that chains these in. Append fork-only checks (browser smoke, web-ui check) after upstream's chain.
- **Version scripts:** Adopt upstream's `--package-lock-only` variant. Drop the fork's `shx rm -rf node_modules ... && npm install` pattern.
- **`devDependencies`:** Take upstream's exact-pin set as the base; add fork-only deps (`concurrently`, anything used by `mom`/`pods`/`web-ui`) at exact pinned versions. See Task 3.1.5 for the tightening pass this implies.
- **Husky (D6):** No change — fork and upstream both keep it.

**File: `tsconfig.json`**
- Upstream changed to enforce erasable TypeScript syntax
- Fork should adopt this for compatibility

**File: `package-lock.json`**
- **Discard both versions** during conflict resolution (`git checkout --theirs -- package-lock.json` is fine here — it does not matter which side wins, the file will be regenerated). Regenerate in Task 3.1 after every other conflict is resolved.
- Do **not** try to hand-merge `package-lock.json` — that path leads to broken installs.

#### Task 2.2: `packages/agent/`

This package has fewer fork changes. Resolve content conflicts by:
1. Taking upstream's refactored code
2. Re-applying any fork-specific changes (if any)

Key files:
- `src/agent-loop.ts`
- `src/types.ts`
- `test/agent-loop.test.ts`

#### Task 2.3: `packages/tui/`

Medium complexity. Upstream made terminal theme and rendering improvements.

Strategy: Take upstream changes, verify fork's custom themes still work.

Key files:
- `src/components/editor.ts`
- `src/components/loader.ts`
- `src/components/markdown.ts`
- `src/terminal-image.ts`
- `src/tui.ts`

#### Task 2.4: `packages/ai/` (High Complexity)

This is the highest-risk package. Fork has many custom providers and model additions.

**Step 2.4.1: Provider files**
For each provider file with conflicts:
1. Take upstream's refactored base
2. Re-apply fork's custom model additions

Files requiring careful merge:
- `src/providers/anthropic.ts` — Add Claude Opus 4.7 to upstream's refactored file
- `src/providers/openai-codex-responses.ts` — Major upstream refactor; fork may have GPT-5.5 additions
- `src/providers/openai-completions.ts` — Major upstream refactor
- `src/providers/amazon-bedrock.ts` — Upstream updates + fork changes
- `src/providers/mistral.ts` — Upstream updates
- `src/providers/cloudflare.ts` — Upstream updates

**Step 2.4.2: Model catalog**
- `src/models.generated.ts` — **DO NOT MERGE MANUALLY**
- Strategy: Take upstream's version, then run fork's model generation script to regenerate with fork's custom models
- Fork's generation script is at `packages/ai/scripts/generate-models.ts`
- Verify it includes: GPT-5.5, Claude Opus 4.7, Fireworks Fire Pass, Kimi K2.6 Turbo

**Step 2.4.3: New providers**
- `src/providers/google-gemini-cli.ts` — Resolve modify/delete conflict. Upstream v0.75.4 deletes it; fork should preserve it unless there is an explicit decision to retire Google Gemini CLI support.
- `src/providers/proxx-debug.ts` — Fork-only, no conflict
- `src/utils/oauth/google-gemini-cli.ts` — Resolve modify/delete conflict; preserve if provider is preserved
- `src/utils/oauth/google-antigravity.ts` — Fork-only relative to upstream v0.75.4; preserve if Antigravity extension is preserved

**Step 2.4.4: Test files**
- Most test conflicts can be resolved by keeping both test cases
- If upstream deleted a test file fork added (e.g., `google-gemini-cli-*.test.ts`), keep fork's

#### Task 2.5: `packages/coding-agent/` (Very High Complexity)

This package has the most conflicts. Upstream made extensive changes to:
- Session management
- Extension system
- Tools (bash, read, edit, find, grep, ls, write)
- TUI interactive mode
- Model registry/resolver
- Configuration

**Strategy: Take upstream, re-apply fork customizations.**

**Step 2.5.1: Core session & runtime**
- `src/core/agent-session.ts` — Upstream simplified this significantly. Take upstream, verify fork's custom session features still work.
- `src/core/agent-session-runtime.ts` — Upstream changes
- `src/core/agent-session-services.ts` — Upstream changes

**Step 2.5.2: Extensions**
- `src/core/extensions/types.ts` — Upstream changed extension API. Fork's extensions may need updates.
- `src/core/extensions/loader.ts` — Upstream changes
- `src/core/extensions/runner.ts` — Upstream changes
- `src/core/extensions/wrapper.ts` — Upstream changes

**Step 2.5.3: Tools**
- `src/core/tools/bash.ts` — **CRITICAL** — Upstream added incremental bash output streaming. Fork may have customizations. Careful merge required.
- `src/core/tools/read.ts` — Upstream added compact rendering. Fork may have custom read behavior.
- `src/core/tools/edit.ts` — Upstream changes
- `src/core/tools/find.ts` — Upstream changes
- `src/core/tools/grep.ts` — Upstream changes
- `src/core/tools/ls.ts` — Upstream changes
- `src/core/tools/write.ts` — Upstream changes

**Step 2.5.4: Model registry**
- `src/core/model-registry.ts` — Fork added custom provider discovery and model pinning. Must preserve.
- `src/core/model-resolver.ts` — Fork changes

**Step 2.5.5: System prompt**
- `src/core/system-prompt.ts` — Upstream added XML boundaries. Fork rebranded to "shuvcode". Must merge both.

**Step 2.5.6: Interactive mode**
- `src/modes/interactive/interactive-mode.ts` — Large file, many upstream changes. Fork may have custom UI.

**Step 2.5.7: Config & CLI**
- `src/config.ts` — Upstream added new config options. Fork has custom config. Merge carefully.
- `src/cli/args.ts` — Upstream changes
- `src/cli.ts` — Upstream changes

**Step 2.5.8: Tests**
- Many test files conflict. Strategy: Keep upstream tests, add fork's additional test cases.
- `test/fast-mode.test.ts` — Fork-only, keep
- `test/compaction-thinking-model.test.ts` — Fork-only, keep

#### Task 2.6: `packages/web-ui/`, `packages/mom/`, `packages/pods/`

These packages were **deleted upstream** but are **active in the fork**.

Strategy: Keep all fork files as-is. They won't have upstream changes to merge (upstream deleted them).

However, these packages depend on `packages/ai/` and `packages/coding-agent/`. After merging those packages, verify:
1. `packages/web-ui/` builds successfully
2. `packages/mom/` builds successfully  
3. `packages/pods/` builds successfully

May need to update imports if upstream changed exports.

---

### Phase 3: Integration & Verification (3-5 hours, includes dependency-pinning sweep)

#### Task 3.1: Dependency Resolution

```bash
rm -rf node_modules packages/*/node_modules package-lock.json
npm install --package-lock-only --ignore-scripts
npm run shrinkwrap:coding-agent
```

Only run a full install with scripts after reviewing the regenerated lockfile and shrinkwrap diff.

#### Task 3.1.5: Dependency Pinning Sweep (NEW)

`check:pinned-deps` will reject the merged tree on the first run because fork-only `devDependencies` (`concurrently`, `husky`, `@types/node`, etc. — anywhere a `^` or `~` appears) are not pinned to exact versions. Upstream's posture (D5) is to pin everything.

```bash
# Find every non-exact range in workspace package.jsons
rg '"\^|"~' --json -g 'package.json' -g 'packages/**/package.json' \
  | jq -r 'select(.type=="match") | "\(.data.path.text):\(.data.line_number):\(.data.lines.text)"'
```

For each match:
1. Resolve the current installed version from the regenerated `package-lock.json`.
2. Replace the range with that exact version in `package.json`.
3. Verify dev/test still resolve.

Then re-run the hardening gates:

```bash
npm install --package-lock-only --ignore-scripts   # lockfile catches up with pinned ranges
npm run check:pinned-deps                          # must pass
npm run check:shrinkwrap                           # must pass
npm run check:ts-imports                           # must pass (D8)
```

Expect this pass to take 10-30 minutes. Do not skip it — `npm run check` will block any commit/release until it's clean.

#### Task 3.2: Type Checking
```bash
npm run check
```

Expected: May fail on first run. Fix TypeScript errors in fork packages if upstream changed types.

#### Task 3.3: Build Verification
```bash
npm run build
```

#### Task 3.4: Test Execution
Per package:
```bash
cd packages/ai && npm test
cd packages/agent && npm test
cd packages/tui && npm test
cd packages/coding-agent && npm test
```

Note: `packages/mom`, `packages/pods`, `packages/web-ui` may not have test suites.

#### Task 3.5: Custom Provider Verification
Manually verify fork's custom providers still work:
1. Fireworks Fire Pass
2. GPT-5.5
3. Claude Opus 4.7
4. Google Gemini CLI
5. Custom provider discovery in web-ui

#### Task 3.6: Commit the Merge

**Verification gate — every check must pass before `git commit`:**

```bash
# 1. No unmerged paths in index (catches "forgot to git add" cases)
unmerged=$(git ls-files -u)
[ -z "$unmerged" ] || { echo "Unmerged paths remain:"; echo "$unmerged"; exit 1; }

# 2. No conflict markers in tracked source-like files (scoped to avoid false positives
#    in package-lock.json, markdown rules, snapshots, encoded blobs)
if git grep -nE '^(<{7}|={7}|>{7}) ' -- \
     ':(exclude)package-lock.json' \
     ':(exclude)*.md' \
     ':(exclude)*.snap' \
     ':(exclude)**/fixtures/**' \
     ':(exclude)**/*.lock'; then
  echo "Unresolved conflict markers above"; exit 1
fi

# 3. Whitespace + indent sanity on staged hunks
git diff --check --cached

# 4. Restored fork-owned paths are actually present
for p in packages/mom packages/pods packages/web-ui \
         packages/ai/src/providers/google-gemini-cli.ts \
         packages/coding-agent/src/core/fast-mode.ts; do
  [ -e "$p" ] || { echo "FATAL: $p missing after restore"; exit 1; }
done

# 5. Hardening gates pass
npm run check:pinned-deps
npm run check:shrinkwrap
npm run check:ts-imports

# 6. Type check passes (or has only known issues you intend to fix in follow-up)
npm run check
```

If every check passes:

```bash
git add -A
git commit -m "chore: sync upstream v0.75.4

Merge upstream pi v0.75.4 into pi-mono fork.

Preserved fork changes:
- packages/mom/ (sandbox runtime, Slack bot)
- packages/pods/ (model pod management)
- packages/web-ui/ (web UI with custom providers)
- Custom AI providers (Fireworks Fire Pass, GPT-5.5, Claude Opus 4.7)
- Web-UI features (model pinning, custom provider discovery)
- Rebrand system prompt to shuvcode
- Additional extensions (qwen-cli, antigravity-image-gen)

Adopted upstream changes:
- Dependency hardening (pinned deps, shrinkwrap)
- Security improvements (npm age gate, scriptless installs)
- TypeScript erasable syntax enforcement
- Tool improvements (incremental bash, compact read)
- Session simplification
- Extension API updates
- Provider refactoring (OpenAI Codex, Bedrock, Mistral)"
```

---

## 7. Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| **Wrong merge base replays old upstream history** | High | Critical | Add `git merge -s ours v0.70.6 --no-ff` ancestry bridge before merging `v0.75.4` |
| **Silent loss of unchanged fork files in deleted packages** | High | Critical | Use `git checkout HEAD -- <path>` in Task 1.4, **never** `--ours`. See §4.2.A for the mechanics. Verification step in Task 3.6 confirms presence. |
| **Accidental deletion of fork packages (modified files)** | High | Critical | Restore whole `packages/mom`, `packages/pods`, and `packages/web-ui` directories via the `restore-fork-owned.sh` script before staging |
| **Model catalog corruption** | High | High | Regenerate from fork's generation script rather than manual merge (Task 2.4.2) |
| **Custom providers broken** | High | High | Test each provider after merge (Task 3.5) |
| **Pinned-deps check fails on merge commit** | High | Medium | Run Task 3.1.5 dependency-pinning sweep before final commit |
| **Web-UI build failure** | Medium | High | Build web-ui separately, fix import errors |
| **Extension API incompatibility** | Medium | Medium | Update fork extensions to match upstream API |
| **Session behavior changes** | Medium | Medium | Run full integration tests |
| **Type errors from TS syntax changes** | Medium | Medium | Run `npm run check`, fix errors systematically |
| **`.js` import-extension drift** | Medium | Low | D8 adopted; `check:ts-imports` enforces; expect 20-60 min of mechanical fixups |
| **Node 22 requirement breaks a deployment target** | Low | High | D2 adopted upfront — flag deployment targets stuck on Node 20 before merge starts |
| **Lost fork commits** | Low | Critical | Use merge (not rebase) to preserve history |
| **Test regressions** | Medium | Medium | Run full test suite |

---

## 8. Rollback Plan

If the merge becomes unmanageable:

```bash
# Abort an in-progress merge (before commit)
git merge --abort
```

If the ancestry bridge was already committed but the v0.75.4 merge was not completed, abandon the merge branch and create a fresh one from `main` later. Do not use destructive reset commands unless explicitly approved.

```bash
git switch main
git branch merge/upstream-0.75.4-abandoned merge/upstream-0.75.4
git branch -D merge/upstream-0.75.4
```

If the merge was already committed on the staging branch, keep it for analysis and create a new branch from `main`. `origin/main` remains untouched until merge is verified and fast-forwarded intentionally.

**Reflog safety net:** Even if a destructive reset accidentally happens, every commit on the merge branch survives in the reflog for at least 90 days:

```bash
git reflog show merge/upstream-0.75.4
git reflog show HEAD | head -50

# Recover a lost merge commit by its SHA from the reflog
git branch merge/upstream-0.75.4-recovered <sha-from-reflog>
```

This means there is **no scenario** in which a botched local merge loses fork commits as long as the local repo's `.git/` is intact. The only true loss vector is force-pushing to `origin/main`, which this plan never does — push only to a feature branch and merge via PR.

---

## 9. Time Estimate

| Phase | Estimated Time |
|-------|---------------|
| Pre-flight decisions (§1.5) | 30 min (already done if defaults accepted) |
| Phase 1: Preparation + ancestry bridge + restore | 1-2 hours |
| Phase 2.1-2.3: Root files, agent, tui | 1-2 hours |
| Phase 2.4: `packages/ai/` (high complexity; openai-codex-responses alone is multi-hour) | 3-5 hours |
| Phase 2.5: `packages/coding-agent/` (highest complexity) | 4-6 hours |
| Phase 2.6: web-ui/mom/pods verification | 1-2 hours |
| Phase 3.1.5: Dependency pinning sweep | 30 min - 1 hour |
| Phase 3.2-3.6: Type-check, build, tests, custom provider verification, commit | 2-4 hours |
| **Total** | **13-22 hours** |

**Recommendation:** Spread across 3-4 days with verification checkpoints at the end of each phase. The previous 7-14h estimate was optimistic; openai-codex-responses refactoring and the coding-agent session/extension/tool surface alone consume most of a working day.

---

## 10. Quick Reference: Files to NEVER Take Upstream Version

These files/directories are fork-owned relative to the v0.75.4 target and must be preserved unless an explicit retire decision is made:

```
packages/mom/
packages/pods/
packages/web-ui/
packages/coding-agent/examples/extensions/custom-provider-qwen-cli/
packages/coding-agent/examples/extensions/antigravity-image-gen.ts
packages/ai/src/providers/proxx-debug.ts
packages/ai/src/providers/google-gemini-cli.ts
packages/ai/src/utils/oauth/google-antigravity.ts
packages/ai/src/utils/oauth/google-gemini-cli.ts
packages/ai/test/google-gemini-cli-claude-thinking-header.test.ts
packages/ai/test/google-gemini-cli-empty-stream.test.ts
packages/ai/test/google-gemini-cli-retry-delay.test.ts
packages/ai/test/google-tool-call-missing-args.test.ts
packages/coding-agent/src/core/fast-mode.ts
packages/coding-agent/test/fast-mode.test.ts
.pi/extensions/diff.ts
.pi/extensions/files.ts
```

---

*Plan generated: 2026-05-20*
*Plan revised: 2026-05-20 (review pass 2 — applied review recommendations: HEAD-restore fix, stale add/add section rewrite, pre-flight decisions baked in, verification gate strengthened, dependency-pinning sweep added)*
*Upstream base: v0.70.6*
*Upstream target: v0.75.4*
*Fork HEAD: e974ce51*
