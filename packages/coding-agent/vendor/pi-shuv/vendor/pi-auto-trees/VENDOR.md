# Vendored Provenance: pi-auto-trees

**Source:** https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-auto-trees
**Package:** `@howaboua/pi-auto-trees`
**Version:** 0.1.4
**Commit:** d03e85e24349100fed560daf22563ee03c3bf48c
**Date:** 2026-05-28 22:29:40 +0100
**License:** MIT

**Contents:** `index.ts` only — the runtime extension source (single file). `README.md`
and `LICENSE` copied for reference. Build tooling (`biome.json`, `tsconfig.json`,
`package.json`) omitted.

**Local modification:** the upstream import scope `@earendil-works/pi-coding-agent`
was rewritten to `@shuv1337/shuvpi-coding-agent` to match the rest of pi-shuv's
vendored extensions. No other changes.

**What it does:** adds `/marker` and `/end` slash commands for incremental
long-running coding sessions. `/marker` checkpoints the current conversation
point; `/end` summarizes work since the marker, jumps back, and advances the
marker. `/end` modes: default, `git`, `full`, or a custom focus prompt.

**API used (all present in the installed `@shuv1337/shuvpi-coding-agent`):**
`ExtensionAPI`, `ExtensionContext`, `ctx.sessionManager.{getBranch,getLeafId,getEntry,getLabel}`,
`pi.{setLabel,appendEntry,registerCommand,on}`, `ctx.navigateTree(..., { summarize, customInstructions, replaceInstructions })`.

**Verification:**
```bash
# diff against a fresh shallow clone (expect only the import-scope line to differ):
cd /tmp && git clone --depth 1 https://github.com/IgorWarzocha/howaboua-pi-stuff.git
diff /tmp/howaboua-pi-stuff/packages/pi-auto-trees/index.ts \
     ~/dotfiles/pi/pi-shuv/vendor/pi-auto-trees/index.ts
```
