# HANDOFF

## Objective
Investigate and fix dramatic shuvpi-agent (shuvpi CLI) launch slowdown. Root cause found and fixed; three follow-ups completed.

## Current status
- Done: launch went from **17.2 s → 6.7 s** (61% faster).
- Done: shuvpi-shuv vendor imports switched from `dist/index.js` to source `index.ts` for all 9 vendors that have source. `shuvpi-tool-policy` keeps `index.js` (only file).
- Done: `shuvpi-context/src/index.ts` syntax error fixed (4 duplicate closing lines at 510-513 from a botched merge).
- Done: `diff-renderer` `build:bundle` now externalizes shuvpi runtime packages; rebuilt bundle is **23 KB** (was 9.9 MB).
- Done: misleading `time("readPipedStdin")` label fixed in `main.ts` — now correctly attributes time to `createAgentSessionRuntime`.
- Done: `npm run check` passes (biome + tsgo + browser-smoke + web-ui).
- Not done: nothing committed, no PR opened.

## Key context
- Root cause: `shuvpi-shuv/index.ts` imported `vendor/diff-renderer/dist/index.js` (9.9 MB). That bundle was rebuilt 2026-04-07 without externals, so `bun build` walked the `@mariozechner/shuvpi-coding-agent` re-export chain and inlined all of `@mariozechner/jiti`, `@babel/*`, `@anthropic-ai/sdk`, `ajv`. Loading that via jiti on every launch cost ~11 s.
- `diff-renderer/AGENTS.md` already said dist is "for inspection only, not the runtime entry" — shuvpi-shuv was ignoring that intent.
- AGENTS.md rules: `npm run check` after code changes; never `npm run dev/build/test`; never commit unless asked.

## Important files
- `~/dotfiles/shuvpi/shuvpi-shuv/index.ts` — vendor imports, now from source.
- `~/dotfiles/shuvpi/shuvpi-shuv/vendor/shuvpi-context/src/index.ts` — duplicate closing block removed.
- `~/dotfiles/shuvpi/shuvpi-shuv/vendor/diff-renderer/package.json` — externals added to `build:bundle`.
- `~/dotfiles/shuvpi/shuvpi-shuv/vendor/diff-renderer/dist/index.js` — regenerated, 23 KB.
- `~/repos/shuvpi-mono/packages/coding-agent/src/main.ts:606,612` — timing labels.

## Validation
- `SHUVPI_TIMING=1 SHUVPI_STARTUP_BENCHMARK=1 SHUVPI_OFFLINE=1 ./shuvpi-test.sh` (run via tmux for TTY): TOTAL 6,703 ms, `createAgentSessionRuntime: 6,665 ms`, `readPipedStdin: 0 ms`.
- `npm run check`: clean.
- Manually loaded interactive TUI; all extensions register, powerline footer renders.

## Next steps
1. If user wants commit: only `packages/coding-agent/src/main.ts` is in this repo. Use `git add <specific path>`, no `git add -A`. The shuvpi-shuv changes are outside this repo (in `~/dotfiles/shuvpi/shuvpi-shuv`, untracked).
2. Optional: similar audit on the other ~1 s extensions (`shuvpi-interactive-shell`, `shuvpi-subagents`, project-local `.shuvpi/extensions/*`) if further startup gains wanted — these are legitimate jiti transpile costs, structural.

## Risks / open questions
- None blocking. User approved the source-import approach explicitly.

## Resume prompt
"Read HANDOFF.md. The shuvpi launch slowdown is fixed; only `packages/coding-agent/src/main.ts` is staged-worthy in this repo. Ask before committing."
