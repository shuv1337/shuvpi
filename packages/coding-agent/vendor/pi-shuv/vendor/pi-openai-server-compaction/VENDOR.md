# Vendored Provenance: pi-openai-server-compaction

**Source:** https://github.com/algal/pi-openai-server-compaction
**Package:** `pi-openai-server-compaction`
**Version:** 0.1.0
**Commit:** c6d593087709e9481223dc6c6c2269b371b5e055
**Date:** 2026-07-17 11:51:14 -0700
**License:** MIT (`LICENSE.md`)

**Contents:** `src/` (9 files, full extension source), `README.md` and `LICENSE.md`
for reference. Omitted: `tests/`, `benchmarks/`, `scripts/`, `tsconfig.json`,
`package.json` (upstream targets pi `>=0.80.9 <0.81.0`; verified compatible
with local shuvpi `0.81.1`).

**Local modifications:**

1. Import-scope rebrand: `@earendil-works/pi-coding-agent` →
   `@shuv1337/shuvpi-coding-agent`, `@earendil-works/pi-agent-core` →
   `@shuv1337/shuvpi-agent-core`, `@earendil-works/pi-ai` (+ `/compat`) →
   `@shuv1337/shuvpi-ai`.
2. `src/config.ts`: config file paths retargeted to the shuvpi runtime —
   global config is now `getAgentDir()/openai-server-compaction.json`
   (i.e. `~/.shuvpi/agent/`, respects `SHUVPI_AGENT_DIR`) and project-local is
   `.shuvpi/openai-server-compaction.json` (was `~/.pi/agent/` and `.pi/`).
3. Env-var overrides intentionally kept as upstream's
   `PI_OPENAI_SERVER_COMPACTION_*` namespace so behavior stays in sync with
   the upstream README.
4. `~/.codex` reference in `src/remote-compaction.ts` kept as-is — that is the
   Codex CLI's own config dir, not a pi runtime path.

**Runtime dependency:** `ws` (dynamically imported in
`src/openai-ws-connection.ts` for the WebSocket transport); declared in the
pack's root `package.json` dependencies.

**What it does:** Codex-style server-side compaction for OpenAI models. On Pi
compaction events it calls OpenAI's Responses compaction v2 endpoint
(`compaction_trigger` → opaque encrypted `compaction` item) in parallel with a
portable Pi text summary, and stores the remote artifact in
`CompactionEntry.details.remoteCompaction`. For direct `openai/*` models it
also patches requests with `store: true` + `context_management`, uses
`previous_response_id` continuation, and provides a WebSocket transport with
HTTP fallback. For `openai-codex/*` it keeps the built-in transport and only
replays reconstructed remote history after compaction boundaries.

**Config:** `~/.shuvpi/agent/openai-server-compaction.json` or
`.shuvpi/openai-server-compaction.json` (project wins). Keys: `enabled`
(default true), `includeAzure` (false), `compactThreshold` (0),
`thresholdRatio` (0.7), `notify` (false), `usePreviousResponseId` (true).
Note `enabled` defaults to **true** but the extension only activates for
`openai/*` and `openai-codex/*` models. Data-handling caveat: for direct
`openai/*` models it sets `store: true` (OpenAI retains conversation data
server-side).

**Verification:**

```bash
# diff against a fresh clone (expect only rebrand + config.ts path changes):
cd /tmp && git clone https://github.com/algal/pi-openai-server-compaction.git
diff -r /tmp/pi-openai-server-compaction/src \
        ~/dotfiles/shuvpi/pi-shuv/vendor/pi-openai-server-compaction/src

# typecheck against installed shuvpi API:
cd ~/dotfiles/shuvpi/pi-shuv
npx tsc --noEmit --allowImportingTsExtensions --module NodeNext \
  --moduleResolution NodeNext --skipLibCheck --target ES2023 --types node \
  vendor/pi-openai-server-compaction/src/index.ts
```
