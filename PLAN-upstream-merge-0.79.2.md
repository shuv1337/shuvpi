# Upstream Merge Plan: pi-mono v0.79.1 → v0.79.2

> **Status:** Completed (2026-06-13). Clean patch sync.
> **Scope:** Merge 29 upstream commits from `pi` `v0.79.1` → `v0.79.2` into the `pi-mono` fork.
> **Risk Level:** LOW — 11 conflicted files, all mechanical (4 package.json scope/version, 5 import-line, 2 lockfiles). One notable: live model-registry drift broke one snapshot test (fixed).

---

## 1. Executive Summary

| | |
|---|---|
| Upstream | `earendil-works/pi` (via local clone `/home/shuv/repos/pi`, remote `upstream-pi`) |
| Merge base | `9ccfcd7c` — clean ancestry ✅ (fork main already contained 3 commits past the v0.79.1 tag) |
| Target | the **`v0.79.2`** tag (`f21f3c4b`), not `upstream-pi/main` |
| New upstream commits | **29** (mostly `fix(...)`; one feature — experimental first-time-setup flow; one model-cost normalization) |
| Conflicts | **11 files**: 4 `package.json` (scope+version), 5 import-line, 2 lockfiles |
| Fork-owned packages (`mom`/`pods`/`web-ui`) | Untouched by v0.79.2; `web-ui` version/pins bumped 0.79.1→0.79.2 for lockstep, `mom`/`pods` left frozen (0.70.6 / 0.77.0 pins, as in prior syncs) |

No ancestry bridge needed. No new `.github/` or `.pi/` files leaked. No `SECURITY.md` re-add this cycle.

## 2. Conflict resolutions

**package.json × 4** (`agent`, `ai`, `coding-agent`, `tui`): keep `@shuv1337/*` scope, adopt upstream `0.79.2` version + `^0.79.2` internal pins.

**Import-line × 5** (keep `@shuv1337` scope, adopt upstream's newly-added sibling imports):
- `ai/scripts/generate-models.ts` — GPT-5.5 `contextWindow: 400000` → `CODEX_STANDARD_CONTEXT` (constant === 400000, equivalent; took upstream).
- `coding-agent/src/cli/startup-ui.ts` — added `existsSync`, `APP_NAME`/`CONFIG_DIR_NAME`/`ENV_AGENT_DIR`/`getSettingsPath`/`PACKAGE_NAME`, `areExperimentalFeaturesEnabled` (first-time-setup feature).
- `coding-agent/src/core/agent-session.ts` — added `getThemeByName`.
- `coding-agent/src/core/settings-manager.ts` — added `randomUUID`.
- `agent/test/agent.test.ts` — added `Type` from `typebox`.

**Lockfiles × 2**: regenerated, not hand-merged.
- `package-lock.json`: `checkout --theirs` base → `npm install --package-lock-only --ignore-scripts`.
- `coding-agent/npm-shrinkwrap.json`: `npm run shrinkwrap:coding-agent` → `npm run check:shrinkwrap` (up to date ✅).

## 3. Namespace sweep

Only 3 real `@earendil-works/pi-*` import leaks (in the 2 new files `first-time-setup.ts`, `5596-missing-theme-export.test.ts`) → renamed to `@shuv1337/pi-*`.

**LOAD-BEARING EXCLUSION:** `startup-ui.ts:15` `OFFICIAL_PACKAGE_NAME = "@earendil-works/pi-coding-agent"` **must stay `@earendil-works`**. It is the fork-detection sentinel for the new first-time-setup feature: `isOfficialDistribution()` compares the fork's `PACKAGE_NAME`/`APP_NAME`/`CONFIG_DIR_NAME` against the official constants. Because the fork is `@shuv1337/pi-coding-agent` + `APP_NAME="shuvcode"`, `isOfficialDistribution()` returns false and first-time setup is correctly skipped on the fork. Renaming this literal would make the fork self-identify as official.

`docs/security.md` `github.com/earendil-works/pi-mono` URL left as upstream (out-of-scope per policy).

## 4. Generated files

- `models.generated.ts`: regenerated from live registry (`cd packages/ai && npm run generate-models`). **Live-registry drift:** the live registry no longer carries `claude-fable-5` on the `opencode` and `vercel-ai-gateway` providers (present in main's 4-day-old snapshot; 16→14 fable-5 entries). All other adaptive-thinking flags unchanged.
- `package-lock.json` + `coding-agent/npm-shrinkwrap.json`: regenerated (137 pkgs shrinkwrap, check passes). Requires `PI_ALLOW_LOCKFILE_CHANGE=1` to commit.

## 5. Test results (`./test.sh`)

`pi-agent-core` 166/166 ✅ · `pi-ai` all pass ✅ · `pi-tui` 667/667 ✅ · `pi-coding-agent` 9 failures (all expected fork rebrand failures).

**Fixed (regen drift):** `ai/test/anthropic-adaptive-thinking-models.test.ts` — removed `opencode/claude-fable-5` and `vercel-ai-gateway/anthropic/claude-fable-5` from the `EXPECTED_CURRENT_ADAPTIVE_THINKING_MODELS` snapshot (those providers dropped Fable 5 from the live registry). Safe edit: it only loosens an `arrayContaining` assertion; the regex invariant (all flagged models match `opus-4-6/7/8 | sonnet-4-6 | fable-5`) still guards correctness.

**Known/expected `pi-coding-agent` failures (NOT merge regressions — fork rebrand):**
- `package-command-paths.test.ts` ×3 — tests removed self-update.
- `system-prompt.test.ts` — asserts "pi docs"; source says "shuvcode docs".
- `theme-export.test.ts` ×2, `theme-picker.test.ts`, `2791-fswatch-error-crash.test.ts` — set `PI_CODING_AGENT_DIR`; fork reads `SHUVCODE_CODING_AGENT_DIR`.
- **NEW this cycle:** `first-time-setup.test.ts > returns true ...` — upstream's positive-path test assumes the official distribution; the fork (`shuvcode`) is correctly non-official so `shouldRunFirstTimeSetup` returns false. Same class as the other rebrand failures; the fork's behavior (skip setup) is correct.
