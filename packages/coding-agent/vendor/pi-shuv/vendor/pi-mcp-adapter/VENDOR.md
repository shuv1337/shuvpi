# Vendored Provenance: pi-mcp-adapter

**Source:** https://github.com/nicobailon/pi-mcp-adapter
**Package:** `pi-mcp-adapter`
**Version:** 2.12.1
**Commit:** 262c17e674de886ef2d524381e90a376aec1811c
**Date:** 2026-07-24 15:01:06 -0700
**License:** MIT (`LICENSE`)

**Contents:** the 46 `.ts`/`.js` entries from upstream's `package.json#files`
(flat layout preserved — `ui-server.ts` serves `app-bridge.bundle.js` from
`import.meta.dirname`, so the bundle must stay a sibling of the sources), plus
`README.md`, `CHANGELOG.md`, `OAUTH.md`, and `LICENSE` for reference.
Omitted: `__tests__/`, co-located `*.test.ts`, `conformance/`, `examples/`,
`.github/`, `banner.png`, `pi-mcp.mp4`, `tsconfig.json`, `vitest.config.ts`,
and `package.json` (upstream dev-deps against pi `0.79.10`; verified compatible
with local shuvpi `0.82.0` — see Verification).

No `package.json` is vendored into this directory on purpose: the pack root
declares `"type": "module"`, and the absence of a nested manifest lets these
files inherit ESM resolution.

**Local modifications:**

1. Import-scope rebrand: `@earendil-works/pi-coding-agent` →
   `@shuv1337/shuvpi-coding-agent`, `@earendil-works/pi-ai` →
   `@shuv1337/shuvpi-ai`, `@earendil-works/pi-tui` → `@shuv1337/shuvpi-tui`.
2. `agent-dir.ts` rewritten to delegate to `getAgentDir()` from
   `@shuv1337/shuvpi-coding-agent` instead of hand-resolving
   `PI_CODING_AGENT_DIR` / `~/.pi/agent`. The adapter's global override and its
   `mcp-oauth/` token store now live in `~/.shuvpi/agent/` (respects
   `SHUVPI_CODING_AGENT_DIR`).
3. `sampling-handler.ts`: `complete` is imported from
   `@shuv1337/shuvpi-ai/compat`, not the package root. shuvpi's core `index.ts`
   is deliberately side-effect-free and does not re-export it; upstream's pi-ai
   root did. Same signature, no behavior change.
4. `config.ts`: project-local override retargeted `.pi/mcp.json` →
   `.shuvpi/mcp.json`, and the project-root marker in `findProjectRoot()`
   `.pi` → `.shuvpi`.
5. `cli.js`: `PI_CODING_AGENT_DIR` → `SHUVPI_CODING_AGENT_DIR`,
   `~/.pi/agent` → `~/.shuvpi/agent`, `.pi/mcp.json` → `.shuvpi/mcp.json`.
   Not wired as a `bin` in this pack — invoke as
   `node vendor/pi-mcp-adapter/cli.js init`.
6. Doc-string path updates to match the above (`mcp-setup-panel.ts` precedence
   list, `types.ts` `oauthDir` example). `README.md`/`CHANGELOG.md` are left as
   upstream wrote them and still say `.pi`.
7. `MCP_*` env-var overrides (`MCP_OAUTH_DIR`, `MCP_UI_VIEWER`,
   `MCP_DIRECT_TOOLS`, `MCP_OAUTH_CALLBACK_PORT`, `MCP_UI_DEBUG`,
   `GLIMPSE_BINARY`) intentionally kept as upstream — they carry no `pi`
   namespace, so they stay in sync with the upstream README.

**Runtime dependencies** (added to the pack root `package.json`):
`@modelcontextprotocol/client@2.0.0-beta.5`, `@modelcontextprotocol/ext-apps`,
`@modelcontextprotocol/sdk`, `cross-spawn`, `open`, `recheck`, `smol-toml`,
`strip-json-comments`, `zod`. `typebox` was already a peer dep.
Note: the transitive `msgpackr-extract` native build is blocked by npm's
`allowScripts` policy; it is an optional accelerator with a pure-JS fallback.

**What it does:** exposes MCP servers through a single `mcp` gateway tool
(~200 tokens) instead of registering every server's tools up front, so tool
definitions stop eating the context window. The agent calls
`mcp({ search: "..." })` to discover and `mcp({ tool, args })` to invoke.
Servers are lazy — they only spawn when a tool is actually called — and tool
metadata is cached so search/describe work without a live connection.
Also supports direct tool promotion, MCP prompts, sampling, elicitation,
OAuth 2.1 (`/mcp-auth`), and MCP-UI apps rendered via a local HTTP host.

**Registers:** tool `mcp`; commands `/mcp`, `/mcp-auth`; flag `--mcp-config`;
handlers on `session_start`, `session_shutdown`, `tool_result`.

**Config** (read in precedence order, later wins):
`~/.config/mcp/mcp.json` → `~/.agents/mcp.json` → `~/.agents/mcp/mcp.json` →
`~/.shuvpi/agent/mcp.json` → `.mcp.json` → `.shuvpi/mcp.json`.
None of these exist on this machine yet — run `/mcp setup` to scaffold one or
import from Cursor / Claude Code / Codex / opencode / Windsurf / VS Code
configs. A stale `~/.shuvpi/agent/mcp-oauth/supabase` token dir survives from
the older standalone fork and will be picked up by this build.

**Verification:**

```bash
# diff against a fresh clone (expect only the modifications listed above):
cd /tmp && git clone https://github.com/nicobailon/pi-mcp-adapter.git
for f in ~/dotfiles/shuvpi/pi-shuv/vendor/pi-mcp-adapter/*.ts \
         ~/dotfiles/shuvpi/pi-shuv/vendor/pi-mcp-adapter/*.js; do
  diff "/tmp/pi-mcp-adapter/$(basename "$f")" "$f"
done

# typecheck against the installed shuvpi API (the pack's own `npm run
# typecheck` has a narrow `include` and does NOT cover vendor/):
cd ~/dotfiles/shuvpi/pi-shuv
npx tsc --noEmit --allowImportingTsExtensions --module NodeNext \
  --moduleResolution NodeNext --skipLibCheck --target ES2023 --types node \
  vendor/pi-mcp-adapter/index.ts
```
