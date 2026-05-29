# Upstream Merge Plan: pi-mono v0.75.4 → v0.77.0

> **Status:** Ready for review. Empirically grounded in a trial merge (no ancestry bridge required this cycle).
> **Scope:** Merge 110 upstream commits from `pi` `v0.75.4` → `v0.77.0` into the `pi-mono` fork.
> **Risk Level:** MODERATE — 31 conflicted files (26 content, 5 fork-deletion). Dramatically smaller than the v0.70.6→v0.75.4 sync (272 conflicts). One high-risk convergence: fork and upstream **independently** added Claude Opus 4.8 + adaptive thinking via different mechanisms; these must be reconciled, not stacked.

---

## 1. Executive Summary

The fork is **one release cycle behind** upstream's latest tag. Unlike the previous sync, the merge base is already a clean `v0.75.4` (`3533843d`) with correct Git ancestry, so **no ancestry bridge is needed** — `git merge v0.77.0` from `main` uses the right base directly.

| | |
|---|---|
| Upstream | `earendil-works/pi` (via local clone `/home/shuv/repos/pi`, remote `upstream-pi`) |
| Merge base | `v0.75.4` (`3533843d`) — clean ancestry ✅ |
| Fork ahead by | 31 commits |
| Upstream ahead by | 110 commits → **`v0.77.0`** (`8322745e`); 125 commits → `upstream-pi/main` (`01a8c2d6`, +15 unreleased) |
| Trial-merge conflicts | **31 files**: 26 content (`UU`) + 5 fork-deletion (`DU`) |
| Fork-owned packages (`mom`/`pods`/`web-ui`) | **Untouched by v0.77.0** — not in the conflict set, restore cleanly |

**Target: the `v0.77.0` tag, not `upstream-pi/main` HEAD.** v0.77.0 is a clean released boundary with a coherent CHANGELOG and regenerated model catalog. The 15 post-tag commits are mostly release/CI plumbing the fork deleted anyway; the few useful ones (`7a5dc0d0` export `convertToPng`, `7619aaef`/`3d1d18fa` Bedrock custom headers, `17e9e875` resume hint, `4faac054` OpenCode reasoning fix) are small and cherry-pickable later if wanted. See §6.

**Why this is much simpler than last time:**
- No ancestry bridge (clean base).
- No fork-package restoration — upstream did **not** re-touch `packages/mom`, `packages/pods`, `packages/web-ui` this cycle, so they don't even appear as conflicts.
- 31 conflicts vs 272. ~half are mechanical `@earendil-works/* → @mariozechner/*` namespace collisions or "both added a top changelog section."

**The one genuinely hard part:** the Opus 4.8 / adaptive-thinking convergence in `packages/ai` (`anthropic.ts`, `generate-models.ts`, `models.generated.ts`, `model-resolver.ts`). Fork and upstream solved the same problem differently — adopt upstream's `compat.forceAdaptiveThinking` architecture and **drop** the fork's now-redundant `supportsAdaptiveThinking()` hardcode, keeping only the fork's genuinely-unique additions (`speed` fast mode, `stopDetails`, mid-conversation system messages, Bedrock region variants, the fork-only google providers + Fireworks router).

---

## 1.5 Pre-flight Decisions

These mirror the prior sync's locked decisions; deltas for this cycle are flagged.

| # | Decision | Default | Notes for this cycle |
|---|----------|---------|----------------------|
| D1 | **Package namespace** `@mariozechner/*` vs `@earendil-works/*` | **Keep `@mariozechner/*`** | This is the single most pervasive conflict driver. Every `package.json`, internal import, and lockfile entry must resolve to `@mariozechner/*`. Upstream's new internal cross-deps (`^0.77.0` ranges) keep the upstream **version** but the fork **scope**. |
| D2 | **Workspace versions** | **Adopt upstream `0.77.0`** for shared packages (`ai`, `agent`, `coding-agent`, `tui`) | Fork-owned `mom`/`pods`/`web-ui` stay on their own version track. Root `version` unchanged. |
| D3 | **Opus 4.8 + adaptive thinking** | **Adopt upstream's `compat.forceAdaptiveThinking` model; layer fork extras on top** | Drop the fork's `supportsAdaptiveThinking()` hardcode (now dead). Keep fork's `speed`/`stopDetails`/system-message code (auto-merged) + Bedrock 4.8 region variants in `generate-models.ts`. See §4.2. |
| D4 | **koffi → native addons (TUI)** | **Adopt upstream's koffi removal** | v0.77.0 replaces koffi FFI with prebuilt `.node` addons. The fork never modified the tui native-loading source, so `terminal.ts`/`editor.ts`/`input.ts` auto-merge to upstream (zero koffi refs). **Drop koffi** from `tui/package.json`, the lockfile, **and** the `generate-coding-agent-shrinkwrap.mjs` allowlist. (Resolves an inconsistency: the lockfile must not retain koffi.) |
| D5 | **Self-update / telemetry / attribution removal** | **Keep removed** | The fork already stripped these in the v0.75.4 sync. Upstream's edits to `config.ts` self-update and `sdk.ts` attribution headers are **not** adopted — take fork. This keeps the two DU test files deleted (see §4.3). |
| D6 | **`models.generated.ts`** | **Regenerate, never hand-merge** | The trial-merge auto-merge already corrupted it (duplicate `claude-opus-4-8` keys, malformed google-provider nesting). Take a clean base, then run the fork's `generate-models.ts`. Requires network (models.dev / OpenRouter / AI gateway). |
| D7 | **Lockfiles (`package-lock.json`, `npm-shrinkwrap.json`)** | **Discard + regenerate** | After all `package.json` files are resolved to `@mariozechner/*`. |
| D8 | **Branding (`shuvcode`)** | **Preserve** | `system-prompt.ts` auto-merged with `shuvcode` intact, but upstream also edited it — verify the rebrand survived and reconcile. README has no shuvcode branding (rebrand lives in system prompts). |
| D9 | **Fork CI/`.pi` deletions** | **Keep deleted** | All `.github/*` and `.pi/*` conflicts resolve to deletion (`git rm`). The fork ships no `.github/` or `.pi/`. |

---

## 2. Current State

### 2.1 The 31 fork commits since v0.75.4

The merge commit `11fbed9c` ("chore: sync upstream v0.75.4") is the boundary. New customizations added **after** the last sync (these must survive this merge):

| SHA | Summary | Category | Survival |
|-----|---------|----------|----------|
| `249b01fa` | add Claude Opus 4.8 + mid-conversation system messages | model | **Conflict-critical** — `anthropic.ts`/`generate-models.ts`/`models.generated.ts` UU; reconcile with upstream's own 4.8 work (§4.2) |
| `ce2d35ae` | default Anthropic & Bedrock to Claude Opus 4.8 | defaults | Re-apply 3 lines in `model-resolver.ts` (UU) |
| `726a3c6f` | bump fast-xml-parser → 5.7.3 in lockfiles | deps | **Subsumed** — upstream already ships 5.7.3; just verify after lockfile regen |
| `71ff9c1c` | removing upstream git workflows (13 `.github` files) | CI-removal | Keep deleted; resolves 2 DU conflicts |
| `5d8cdab1` | removing built-in pi repo exts & prompts (11 `.pi` files) | cleanup | Keep deleted; resolves 1 DU conflict |
| `06eaef33` | security: `pull_request_target`→`pull_request` (openclaw-gate) | security | **Moot** — file deleted by `71ff9c1c`, absent at HEAD |
| `575f4b92` | security: `pull_request_target`→`pull_request` (pr-gate) | security | **Moot** — file deleted by `71ff9c1c`, absent at HEAD |

> **Correction to the prior plan:** `.pi/extensions/diff.ts` and `.pi/extensions/files.ts` are listed in the v0.75.4 plan's "never take upstream" set, but they were deleted by `5d8cdab1` and are absent at HEAD. They belong on the **keep-deleted** side now.

### 2.2 Fork-owned paths to preserve (never take upstream)

Validated present at fork HEAD. Upstream did **not** touch any of these this cycle, so they auto-resolve cleanly (no restoration script needed):

```
packages/mom/                                  packages/web-ui/
packages/pods/                                 packages/coding-agent/src/core/fast-mode.ts
packages/coding-agent/examples/extensions/custom-provider-qwen-cli/
packages/coding-agent/examples/extensions/antigravity-image-gen.ts
packages/ai/src/providers/proxx-debug.ts       packages/ai/src/providers/google-gemini-cli.ts
packages/ai/src/utils/oauth/google-gemini-cli.ts
packages/ai/src/utils/oauth/google-antigravity.ts
packages/ai/test/google-gemini-cli-*.test.ts   packages/ai/test/google-tool-call-missing-args.test.ts
packages/coding-agent/test/fast-mode.test.ts    packages/coding-agent/test/compaction-thinking-model.test.ts
```

Files upstream **also edited** that carry fork customizations and must be reconciled (re-apply fork on upstream base): `anthropic.ts`, `amazon-bedrock.ts`, `types.ts`, `generate-models.ts`, `models.generated.ts`, `model-resolver.ts`, `config.ts`, `sdk.ts`, `system-prompt.ts`.

---

## 3. Upstream Changes v0.75.4 → v0.77.0

110 non-merge commits, 214 files, +9,973/−2,949. **No upstream file deletions.** 37 genuinely new files.

### 3.1 Themes by risk

| Theme | Risk | Summary |
|-------|------|---------|
| **Anthropic adaptive-thinking refactor** | HIGH | Deletes `supportsAdaptiveThinking()`, drives adaptive thinking off `model.compat.forceAdaptiveThinking` (stamped in `generate-models.ts` via `isAnthropicAdaptiveThinkingModel` + `mergeAnthropicMessagesCompat`). Independently adds `claude-opus-4-8`. **Collides with fork's own 4.8 work.** New `allowEmptySignature` compat flag (Xiaomi). |
| **Package scope rename (fork-side)** | HIGH (mechanical) | Pervasive `@earendil-works/* ↔ @mariozechner/*` collisions across every `package.json`, internal import, lockfile. |
| **Tool allowlist/denylist + harness tools API** | MED | New `--exclude-tools`/`-xt` flag, `excludeTools` SDK option, `getTools`/`setTools`/`getActiveTools`, `ActiveToolsChangeEntry`, `tools_update` event. **Breaking renames:** `ModelSelectEvent`→`ModelUpdateEvent`, `ThinkingLevelSelectEvent`→`ThinkingLevelUpdateEvent` (fork `mom`/`pods`/`web-ui` don't reference these — grep-clean). |
| **OAuth device-code login** | MED | New `oauth/device-code.ts` (RFC 8628), Codex device-code login, `OAuthDeviceCodeInfo`. **Breaking:** `OAuthLoginCallbacks.onSelect` now required + new required `onDeviceCode`. Fork's google providers only consume `onAuth`/`onProgress`/`onManualCodeInput` (safe), but any code **constructing** a callbacks object must supply both. |
| **Config-value env-var syntax** | MED | `apiKey`/header values now use `$ENV`/`${ENV}`/`!cmd`/`$$`/`$!`; auto-migration rewrites legacy bare values. Relevant if fork custom providers (Fireworks, proxx, google-*) rely on bare env-var-name `apiKey`. |
| **Path normalization** | MED | `config.ts`/`sdk.ts` route through new `utils/paths.ts` `normalizePath`/`resolvePath`; new `--session-id` flag. Fork takes its own `config.ts`/`sdk.ts`, so these are largely **not** adopted (verify build). |
| **Codex/OpenAI responses hardening** | LOW | SSE header-stall timeout, websocket connect timeout, Retry-After, Codex Spark 128k. Additive. |
| **TUI native input rewrite** | LOW | koffi FFI → compiled native addons (`native/{darwin,win32}/prebuilds/*.node`), `word-navigation.ts` (Intl.Segmenter). Adopt wholesale; drop koffi (D4). |
| **Image resize → worker thread** | LOW | `image-resize.ts` rewritten to delegate to new `image-resize-core.ts`/`image-resize-worker.ts`. **Signature change** `resizeImage(img)` → `resizeImage(bytes, mimeType)` ripples to `read.ts`/`file-processor.ts`. |
| **Bedrock `@smithy/node-http-handler`** | LOW | New `packages/ai` dep `@smithy/node-http-handler@4.7.3`. |
| **CI / publish pipeline** | LOW | New `publish-npm` OIDC job, `scripts/publish.mjs`. Irrelevant — fork deleted all workflows (keep deleted). |

### 3.2 Genuinely new files to adopt

`packages/ai/src/utils/oauth/device-code.ts`, `packages/ai/src/utils/abort-signals.ts`, `packages/coding-agent/src/utils/{deprecation,image-resize-core,image-resize-worker,json}.ts`, `packages/tui/src/{native-modifiers,word-navigation}.ts` + `native/**`, `packages/{ai,coding-agent,agent}/tsconfig.build.json`, new example extensions (`git-merge-and-resolve.ts`, `input-transform-streaming.ts`, `doom-overlay/`, `dynamic-resources/`, `plan-mode/`, `subagent/`), `scripts/publish.mjs` (only if re-enabling publishing), and ~13 new test files.

> **Re-apply namespace to new upstream files:** `image-resize-core.ts`/`image-resize-worker.ts` (and any new file importing `pi-ai`/`pi-agent-core`/`pi-tui`) ship with `@earendil-works/*` — re-apply the `@mariozechner/*` rename after the merge brings them in (grep sweep, §3.4).

### 3.3 Workspaces array

Base v0.75.4 and v0.77.0 have **identical** workspaces arrays — upstream added new example **dirs** but did not register them as workspaces. The final union = fork HEAD's current array (no new members needed):

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

### 3.4 Namespace sweep (do after all conflicts resolved, before lockfile regen)

```bash
# Must return ZERO before regenerating lockfiles / committing:
git grep -n '@earendil-works/pi-' -- 'packages/**/*.ts' 'packages/**/*.json' \
  ':(exclude)packages/web-ui' ':(exclude)packages/mom' ':(exclude)packages/pods'
```

---

## 4. Conflict Resolution (31 files)

### 4.0 Summary table

| Cluster | Files | Dominant resolution |
|---------|-------|---------------------|
| Root/build | `README.md`, `package-lock.json`, `npm-shrinkwrap.json`, `generate-coding-agent-shrinkwrap.mjs` | regenerate lockfiles; manual-merge docs/script |
| **ai models/providers** | `models.generated.ts`, `generate-models.ts`, `anthropic.ts`, `ai/package.json`, `ai/CHANGELOG.md` | **§4.2 — highest risk** |
| ai tests | `context-overflow`, `fireworks-models`, `tokens` `.test.ts` | take-upstream (robust dynamic model lookup) |
| coding-agent core | `config.ts`, `model-resolver.ts`, `sdk.ts`, `tools/bash.ts`, `tools/ls.ts`, `utils/image-resize.ts` | take-fork (config/sdk/model-resolver); take-upstream+rename (bash/ls/image-resize) |
| coding-agent interactive/meta | `footer.ts`, `login-dialog.ts`, `docs/packages.md`, `package.json`, `CHANGELOG.md` | mechanical: namespace + version + changelog union |
| coding-agent tests | `model-registry.test.ts` | keep fork import names + upstream's `vi` & new cases |
| agent/tui pkg | `agent/package.json`, `tui/package.json` | keep `@mariozechner`, adopt `0.77.0`, drop koffi |
| **DU (deletions)** | 5 files | **`git rm` all (§4.3)** |

### 4.1 Mechanical namespace + version conflicts (LOW risk)

`packages/{ai,agent,tui,coding-agent}/package.json`: each conflict hunk is fork's `@mariozechner` name vs upstream's `0.77.0` version (and `^0.77.0` dep ranges). Resolve to **fork scope + upstream version**:
```jsonc
"name": "@mariozechner/pi-<pkg>",
"version": "0.77.0",
// internal deps:
"@mariozechner/pi-ai": "^0.77.0",  // etc.
```
Accept all auto-merged upstream additions: `ai` gains `@smithy/node-http-handler@4.7.3`; `tui` drops `koffi` + `@xterm/xterm`, adds `native/**/prebuilds/*.node` to `files` (D4); `coding-agent` bumps `@mariozechner/clipboard`→`0.3.9` and adds `image-resize-worker` to `build:binary`, keeps `piConfig.name: "shuvcode"`.

Import-block conflicts where fork renamed and upstream added an adjacent import — keep both, apply `@mariozechner`:
- `tools/bash.ts`, `tools/ls.ts`: take upstream's new `node:fs/promises` async imports, re-apply `@mariozechner` on the two scoped lines. (Fork made **no** logic change here — adopt all upstream improvements.)
- `footer.ts`: keep upstream's `import { isAbsolute, relative, resolve, sep } from "node:path"` **and** the `@mariozechner/pi-tui` line. Fork's fast-mode footer indicator below auto-merged.
- `login-dialog.ts`: keep upstream's `type OAuthDeviceCodeInfo` in the `@mariozechner/pi-ai/oauth` import. `showDeviceCode`/`openUrl` bodies auto-merged.
- `model-registry.test.ts`: keep fork's 3 `@mariozechner/pi-ai` import lines **and** upstream's vitest line with `vi`. All new upstream env-reference test cases auto-merged.

`README.md`: one non-overlapping hunk — re-add upstream's **Supply-chain hardening** section (collateral-dropped by fork; fork still ships all the mechanisms it documents) **and** keep the fork's web-ui build `> Note`. Keep `npm install --ignore-scripts`.

`*/CHANGELOG.md`: both added top sections — stack fork's `[Unreleased]` above upstream's `[0.77.0]`/`[0.76.0]`/`[0.75.5]`. Don't collapse the fork's "default model → Opus 4.8" entry into upstream's "Opus 4.8 metadata" entry — different facts.

`docs/packages.md`: take **fork** side of the `pi update` block (keep `--self` lines deleted — fork removed self-update).

### 4.2 The Opus 4.8 / adaptive-thinking convergence (HIGH risk)

Fork (`249b01fa`/`ce2d35ae`) and upstream both added Claude Opus 4.8. Upstream's approach supersedes the fork's hardcode. **Adopt upstream's architecture; keep only fork-unique additions.**

**`packages/ai/src/providers/anthropic.ts`** — take-upstream base, 4 marker hunks:
- AnthropicOptions doc-comment hunk: keep **both** the fork `speed?: "default" | "fast"` block and upstream's `toolChoice` doc-comment (adjacent additions).
- `supportsAdaptiveThinking()` function hunk: **delete entirely** (upstream removed it). The fork's `opus-4-8` additions to it become dead — do not preserve.
- `streamSimpleAnthropic` + `createClient` hunks: take upstream's `model.compat?.forceAdaptiveThinking === true` form.
- **Verify auto-merged fork code survives** (no markers): `speed` fast-mode field, `stopDetails` refusal mapping in `message_delta`, `speed` passthrough in `buildParams`, `convertMessages` `role:"system"` branch.
- After: `git grep supportsAdaptiveThinking packages/ai/src/providers/anthropic.ts` must be **empty**. Validate with new test `anthropic-adaptive-thinking-models.test.ts`.

**`packages/ai/scripts/generate-models.ts`** — 2 marker hunks:
- `applyThinkingLevelMetadata` hunk: take **upstream** — keep upstream's `isAnthropicAdaptiveThinkingModel` + `mergeAnthropicMessagesCompat({forceAdaptiveThinking:true})`; drop the fork's redundant duplicate `opus-4-8` xhigh block (the merged block above already maps it).
- Bedrock fallback hunk: take **fork** — keep the fork's "Add missing Bedrock Claude Opus 4.8 variants" loop (`''`/`us.`/`eu.`/`global.`/`jp.`); upstream has no Bedrock 4.8 fallback.
- **Verify fork-only blocks survive** (outside markers): `cloudCodeAssistModels` (google-gemini-cli), `antigravityModels` (google-antigravity), Fireworks `kimi-k2p6-turbo` router push, Bedrock cost override (4-6/4-7/4-8), 1M-context override, `gpt-5.5-codex` 400k context.
- Run `node scripts/generate-models.ts` to confirm it executes before relying on output.

**`packages/ai/src/models.generated.ts`** — **DISCARD + REGENERATE** (D6). The auto-merge is already corrupted (duplicate `claude-opus-4-8` keys at ~L1866/L1885; malformed google nesting). After `generate-models.ts` and `anthropic.ts` are resolved:
```bash
cd packages/ai && npm run generate-models   # needs network: models.dev / OpenRouter / AI gateway
```
Validate: `compat:{forceAdaptiveThinking:true}` on each Opus 4.8 anthropic entry; google-gemini-cli + google-antigravity provider blocks present; kimi-k2p6-turbo router present; **no duplicate keys / no markers**. Accept the upstream deletion of `anthropic-opus-4-7-smoke.test.ts` (renamed to `-4-8-`).

**`packages/coding-agent/src/core/model-resolver.ts`** — take-fork. One hunk (`amazon-bedrock` default): keep `us.anthropic.claude-opus-4-8`. The fork-only keys `google-gemini-cli`/`google-antigravity` are **required** members of `Record<KnownProvider, string>` — must stay (dropping = type error). anthropic default already coincides (both → `claude-opus-4-8`).

**`packages/ai/src/types.ts` + `amazon-bedrock.ts`** (auto-merged `M`, not in conflict list — **verify**): `StopDetails`, `SystemMessage` interface, `Message` union extension, `AssistantMessage.stopDetails`, and Bedrock `opus-4-8` in `supportsAdaptiveThinking`/`supportsNativeXhighEffort` must have survived. `mistral.ts`/`faux.ts`/`transform-messages.ts` merged clean — confirm `role:"system"` handling present.

### 4.3 Fork-deletion conflicts — `git rm` all 5 (DU)

All five are intentional fork removals; upstream's edits don't apply. Investigated, not collateral:

| File | Why deleted | `git rm` rationale |
|------|-------------|--------------------|
| `.github/APPROVED_CONTRIBUTORS` | `71ff9c1c` (purged all `.github` CI) | Allowlist for a workflow the fork doesn't ship |
| `.github/workflows/build-binaries.yml` | `71ff9c1c` | Upstream added `publish-npm` targeting `@earendil-works` scope — wrong for fork |
| `.pi/prompts/pr.md` | `5d8cdab1` (purged all `.pi`) | Upstream-maintainer prompt template; fork ships none |
| `packages/coding-agent/test/config.test.ts` | dropped in v0.75.4 sync (`11fbed9c`) | Tests `detectInstallMethod`/`getSelfUpdate*` — fork removed self-update; would not compile |
| `packages/coding-agent/test/sdk-openrouter-attribution.test.ts` | dropped in v0.75.4 sync (`11fbed9c`, explicitly noted) | Tests OpenRouter/OpenCode attribution headers + `setEnableInstallTelemetry` — fork stripped both; would not compile |

### 4.4 take-fork core files (LOW risk, but watch the build)

- **`config.ts`** — take-fork (both hunks). Keep the fork's gutted self-update (no `detectInstallMethod`/`getSelfUpdate*`), keep `@mariozechner/pi-coding-agent` `PACKAGE_NAME` fallback, keep inline tilde expansion. **Do not** adopt upstream's `normalizePath` import — fork's `paths.ts` doesn't export it.
- **`sdk.ts`** — **manual-merge, highest-risk in cluster.** The auto-merge left a **compile-breaking** state: the `streamSimple` call references bare `timeoutMs`/`websocketConnectTimeoutMs` that only exist on the deleted upstream side. Rewrite the `streamFn` region to the fork's simpler form (`timeoutMs: options?.timeoutMs ?? providerRetrySettings.timeoutMs`, drop `websocketConnectTimeoutMs` + `attributionHeaders`). Keep fork's `getAttributionHeaders` deletion (D5). **Verify auto-merged:** thinking-level clamp = fork's `if (!model || !model.reasoning) { thinkingLevel = "off"; }` (no `clampThinkingLevel` import), `applyFastModeToPayload` + `sessionRef` present. Decide on upstream's `resolvePath`/`excludeTools` — drop unless `paths.ts` exports `resolvePath`.
- **`utils/image-resize.ts`** — take-upstream rewrite (worker-thread). Drop fork's photon `ImageContent` imports. **Cross-file:** the new signature `resizeImage(bytes, mimeType)` ripples to `read.ts`/`file-processor.ts` — adopt upstream's call form there. Re-apply `@mariozechner` to the new `image-resize-core.ts`/`image-resize-worker.ts`.

### 4.5 Lockfiles + shrinkwrap (regenerate; do LAST)

1. After **all** `package.json` files resolved to `@mariozechner/*`:
   ```bash
   git checkout --theirs package-lock.json
   rm -f package-lock.json && npm install --package-lock-only --ignore-scripts
   ```
2. `scripts/generate-coding-agent-shrinkwrap.mjs`: keep fork's `internalPackagePrefix = '@mariozechner/pi-'`; **remove the koffi allowlist line** (D4 — koffi is gone post-merge); set the `protobufjs` allowlist version to **whatever the regenerated lockfile resolves** (verify — fork pinned 7.6.0, upstream 7.5.9).
3. `npm run shrinkwrap:coding-agent` then `npm run check:shrinkwrap`.
4. Verify `fast-xml-parser` resolves to `5.7.3` (fork commit `726a3c6f` is subsumed).

---

## 5. Execution Plan

### Phase 0 — Prep
```bash
# Working tree is clean. A trial-merge worktree already exists at /tmp/pi-mono-trialmerge (merge in progress) — used for analysis.
git fetch upstream-pi --tags          # ensure v0.77.0 present
git switch -c merge/upstream-0.77.0 main
```

### Phase 1 — Merge + trivial resolutions
```bash
git merge v0.77.0 --no-commit --no-ff   # clean base v0.75.4, no ancestry bridge

# 4.3 — keep fork deletions
git rm .github/APPROVED_CONTRIBUTORS .github/workflows/build-binaries.yml .pi/prompts/pr.md \
       packages/coding-agent/test/config.test.ts \
       packages/coding-agent/test/sdk-openrouter-attribution.test.ts
```
Resolve §4.1 mechanical conflicts (namespace/version/changelog/README/docs).

### Phase 2 — Hard conflicts
Resolve §4.2 (`anthropic.ts`, `generate-models.ts`, `model-resolver.ts`) and §4.4 (`config.ts`, `sdk.ts`, `image-resize.ts` + its 2 callers). **Leave `models.generated.ts` and lockfiles for Phase 3.**

### Phase 3 — Regenerate + namespace sweep
```bash
git grep -n '@earendil-works/pi-' -- 'packages/**' ':(exclude)packages/{web-ui,mom,pods}'   # must be empty
cd packages/ai && npm run generate-models && cd ../..        # regenerate models.generated.ts (network)
git checkout --theirs package-lock.json && rm package-lock.json
npm install --package-lock-only --ignore-scripts
# fix generate-coding-agent-shrinkwrap.mjs allowlist (drop koffi, set protobufjs to resolved version)
npm run shrinkwrap:coding-agent
```

### Phase 4 — Verify (gate before commit)
```bash
git ls-files -u            # no unmerged paths
git grep -nE '^(<{7}|={7}|>{7}) ' -- ':(exclude)package-lock.json' ':(exclude)*.md' ':(exclude)*.snap'   # no markers
npm run check              # pinned-deps + shrinkwrap + ts-imports + typecheck
npm run build              # builds tui→ai→agent→coding-agent→mom→web-ui→pods
# per-package tests
( cd packages/ai && npm test )            # incl. anthropic-adaptive-thinking-models.test.ts
( cd packages/agent && npm test )
( cd packages/coding-agent && npm test )  # incl. model-registry env-reference cases
( cd packages/tui && npm test )
```
Functional spot-checks: Opus 4.8 default + adaptive thinking; fork custom providers (Fireworks, GPT-5.5, google-gemini-cli/antigravity) load; web-ui custom-provider discovery; tui input works with native addons (no koffi).

### Phase 5 — Commit + PR
```bash
git commit   # message in §5.1
git push -u origin merge/upstream-0.77.0   # PR into main; never force-push origin/main
```

### 5.1 Commit message
```
chore: sync upstream v0.77.0

Merge upstream pi v0.77.0 (110 commits from v0.75.4) into pi-mono fork.

Adopted upstream:
- Claude Opus 4.8 adaptive-thinking via model.compat.forceAdaptiveThinking
- --exclude-tools flag + harness getTools/setTools API
- OAuth device-code login (Codex), config-value env-var apiKey syntax
- Codex/OpenAI transport hardening; image resize on worker thread
- TUI native modifier addons (replaces koffi FFI); Unicode word navigation
- Bedrock @smithy/node-http-handler

Preserved fork customizations:
- @mariozechner/* package scope
- packages/mom, packages/pods, packages/web-ui (untouched upstream)
- Custom providers: Fireworks Fire Pass, GPT-5.5, google-gemini-cli, google-antigravity, proxx-debug
- Opus 4.8 extras: speed fast mode, stopDetails, mid-conversation system messages, default model, Bedrock region variants
- shuvcode system-prompt rebrand
- Removed self-update/telemetry/attribution; deleted .github/.pi (kept deleted)

Regenerated: models.generated.ts, package-lock.json, coding-agent shrinkwrap.
```

---

## 6. Deferred (post-tag, optional cherry-picks)

From the 15 `v0.77.0..upstream-pi/main` commits — cherry-pick only if wanted after the merge lands:
- `7a5dc0d0` — export `convertToPng` for extensions (one-line)
- `7619aaef` / `3d1d18fa` — Bedrock custom-header support
- `17e9e875` — print resume hint on interactive exit
- `4faac054` — fix OpenCode reasoning params

Skip (release/CI plumbing the fork doesn't use): `93600d89`, `f3b4e128`, `b6b0f692`, `20bcab26`, `abf07d0c`, `7be8a10d`, contributor approval.

---

## 7. Risk Register

| Risk | Prob | Impact | Mitigation |
|------|------|--------|-----------|
| `models.generated.ts` corruption from hand-merge | High | High | **Never hand-merge** — regenerate (§4.2/D6). Trial merge already shows duplicate keys as proof. |
| `sdk.ts` compile-break from auto-merge | High | High | Rewrite `streamFn` to fork form (§4.4); typecheck gate (Phase 4). |
| Opus 4.8 adaptive thinking silently breaks | Med | High | Regenerated catalog must carry `compat.forceAdaptiveThinking`; `anthropic-adaptive-thinking-models.test.ts` validates. |
| koffi inconsistency (lock keeps it, src drops it) | Med | Med | D4: drop koffi everywhere incl. shrinkwrap allowlist. |
| `@earendil-works/*` leak after merge | Med | Med | Namespace sweep gate (§3.4), incl. new upstream files. |
| `paths.ts` `normalizePath`/`resolvePath` missing | Med | Med | Take-fork on config/sdk; drop those imports; typecheck catches. |
| Regenerate needs network | Med | Med | Run Phase 3 in a networked env; treat unrelated model drift as normal. |
| OAuth callback contract (`onSelect`/`onDeviceCode` required) | Low | Med | Fork google providers only consume `onAuth`/`onProgress` (safe); audit any callbacks-constructing code. |
| Custom-provider `apiKey` bare-env breakage | Low | Med | Verify Fireworks/proxx/google use `$ENV` syntax post-migration. |
| Lost fork commits | Low | Critical | Merge (not rebase); push to feature branch only; reflog safety net. |

---

*Plan generated: 2026-05-29*
*Method: trial merge (`main` + `v0.77.0`) in isolated worktree → 10-agent parallel conflict analysis*
*Upstream base: v0.75.4 (3533843d) · target: v0.77.0 (8322745e) · fork HEAD: ce2d35ae*
