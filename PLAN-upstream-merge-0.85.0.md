# Plan: merge upstream pi v0.85.0 into shuvpi

Status: executing
Decisions: keep web-ui (port to new client protocol as follow-up); delete mom/pods; post-merge version v0.86.0.
Upstream: `earendil-works/pi` `main` (fetched via `upstream-pi` = `~/repos/pi`, ref `upstream-pi/upstream-main`)
Upstream head at time of writing: `Release v0.85.0` + 1 fix (2026-09-05)

## Current state

- Local `main` (fork v0.85.1): merge-base with upstream is `209bc7b9` (2026-08-17).
- Git counts: 564 upstream commits not in local ancestry, 141 local commits not upstream.
- Prior syncs (`feat: merge upstream v0.84.2`, `feat: merge upstream post-v0.84.2 changes`) were content imports, not true merges, so ancestry counts overstate the content gap. Real content gap: upstream 2026-08-18 → 2026-09-05.
- Version collision: fork self-released v0.84.3–v0.85.1; upstream independently released v0.84.3, v0.84.4, v0.85.0. Fork changelog "released" sections will conflict with upstream's and must be reconciled, not merged textually.

## Upstream review (what's in the gap)

Dominated by an agent-core rewrite, not incremental fixes:

1. **Harness v3** (`packages/agent`, ~160 commits): legacy harness runtime replaced ("replace legacy harness runtime", runtime2 merge, bound values/lists, invocation context primitives, reducer/session/telemetry rework). Extensive new docs under `packages/agent/docs`.
2. **SQLite session backend** (`packages/session-backends`, new `sqlite` scope): lease lifecycle + renewal, fork coordination with open sessions, corrupt-session skip, cached insert statements.
3. **Client/server/protocol restructure**: remote session event streaming, sessions created for remote prompts, JSONL session ownership enforcement. `packages/client` heavily rewritten.
4. **Package topology change**: upstream **added `packages/chord`**, **removed `packages/mom`, `packages/pods`, `packages/web-ui`**. Fork carries web-ui features (remote agent sessions #229) — decision required.
5. **coding-agent** (~110 commits): settings-selector work, fullscreen transcript controls, persistent thinking effort, `SessionManager.inMemory()`, fd/rg resolution without GitHub API, musl fixes.
6. **ai** (~40 commits): provider stream event-sequence fixes, Codex SSE parsing, Copilot reasoning levels, model catalog churn.

Total diff `main` vs upstream head: 1592 files, +112k/−128k lines.

## Trial merge result

`git merge --no-commit upstream-pi/upstream-main` on a throwaway worktree: **210 conflicted files**.

| Area | Conflicts |
|---|---|
| packages/coding-agent | 81 (src/core 12, examples/extensions 9, src/modes 8, cli/client/bun, ~10 tests) |
| packages/session-backends | 26 |
| packages/server | 25 |
| packages/client | 19 |
| packages/agent | 19 (harness core: agent-harness, reducer, session/*, telemetry) |
| packages/ai | 15 |
| packages/tui / protocol / telemetry | 11 |
| root/scripts/.github | ~14 (package.json, lockfile, release workflow, shrinkwrap scripts) |

The agent/client/server/session-backends conflicts are rewrite-vs-fork-patch conflicts; textual resolution will often be wrong. Take upstream wholesale there and re-apply fork deltas on top.

## Decision points (resolve before executing)

1. **web-ui**: upstream deleted it; fork added remote agent sessions to it (#229). Keep as fork-only package (accept maintenance cost against the new client/server protocol), or drop and rely on upstream's remote-session streaming?
2. **mom / pods**: upstream deleted. Any fork usage? If none, follow upstream and delete.
3. **Version numbering**: post-merge release should jump to a number clear of both lines (suggest fork v0.86.0) and changelogs must state which upstream release the merge lands.
4. **Codex runtime sidecar**: fork retired it (`a85fa6a00`); verify upstream didn't reintroduce or depend on it.

## Merge strategy

Branch: `merge-upstream-0.85.0` off `main` (jj: `jj new main`).

Order of resolution — take-upstream-first for rewritten packages, fork-first for identity/release plumbing:

1. **Take upstream wholesale**: `packages/agent`, `packages/client`, `packages/server`, `packages/protocol`, `packages/session-backends`, `packages/telemetry`, `packages/chord` (new). Then re-apply fork-specific deltas found by `git log 209bc7b9..main -- packages/<pkg>` (expected: few; most fork work is in coding-agent/ai/release).
2. **Take upstream, re-apply fork patches**: `packages/tui`, `packages/ai`. Fork deltas in ai: google-antigravity provider, Gemini 3.8 Flash for Antigravity, Antigravity UA bump, Claude Opus 5 defaults, Cloudflare gateway generation fixes. Re-apply via `generate-models.ts` edits + regenerate, never by hand-merging `models.generated.ts`.
3. **Hand-merge**: `packages/coding-agent`. Fork deltas to preserve: package rename/branding (`@shuv1337/shuvpi`, repository URLs, update-target `d732340b`), bundled shuv extension (`795cfee5b`), universal installer (`925eda302`), extension runCommand API (`6d6ed5b2`), background terminal status truncation (`135dffe4`).
4. **Fork-first**: root `package.json` name/version, `.github/workflows` (keep fork's trusted publishing + Discord notify; fold in upstream CI improvements manually), `scripts/*` release tooling (keep fork's, port upstream's npm-12/pack fixes if not already present), README/SECURITY (fork identity).
5. **Package topology**: delete or keep `mom`/`pods`/`web-ui` per decisions above; if keeping web-ui, port it to the new client protocol in a follow-up task, not inside the merge commit.
6. **Changelogs**: keep both histories; under fork `[Unreleased]` add one line "Merged upstream pi v0.85.0" and preserve upstream's released sections verbatim below fork's (as prior merges did).
7. **Lockfiles**: regenerate (`npm install --package-lock-only --ignore-scripts`, shrinkwrap via `node scripts/generate-coding-agent-shrinkwrap.mjs`); review new-dep lifecycle scripts against the allowlist.

## Validation

1. `npm run check` — zero errors/warnings/infos.
2. `./test.sh` from repo root (non-e2e suite).
3. Local release smoke test per AGENTS.md (node + bun: `--help`, `--version`, `--list-models`, one real prompt, interactive via tmux) — mandatory given the harness rewrite touches session persistence; also resume an existing session to verify JSONL/sqlite migration behavior.
4. Verify shuv extension bundle loads and `runCommand` API still works.
5. Verify update check still targets `@shuv1337/shuvpi`.

## Risk notes

- Highest risk: harness v3 + session-backends replace the session runtime the fork's extension APIs sit on. Expect API drift in `runCommand` and extension host wiring.
- Second: settings-selector/coding-agent core conflicts (12 files in src/core) — upstream refactors vs fork branding/features.
- Estimated effort: this is a multi-hour merge, comparable to the prior 0.79.2 merge, larger due to the agent rewrite. Consider splitting: land upstream-wholesale packages first, then coding-agent hand-merge, in one merge commit but resolved in that order.
