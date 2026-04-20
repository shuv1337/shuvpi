# PLAN: Rename `pi` → `shuv` across the monorepo

## Summary

Rename the internal `pi` brand to `shuv` across package names, binaries, config paths, env vars, user-facing CLI/help text, examples, tests, and documentation.

This plan intentionally keeps the repository directory name as `pi-mono` and keeps external forked dependencies under the `@mariozechner` scope.

## Scope / assumptions

### Canonical rename targets

| Before | After |
|---|---|
| `@mariozechner/pi-ai` | `@shuv1337/shuv-ai` |
| `@mariozechner/pi-agent-core` | `@shuv1337/shuv-agent-core` |
| `@mariozechner/pi-coding-agent` | `@shuv1337/shuv-coding-agent` |
| `@mariozechner/pi-mom` | `@shuv1337/shuv-mom` |
| `@mariozechner/pi` | `@shuv1337/shuv-pods` |
| `@mariozechner/pi-tui` | `@shuv1337/shuv-tui` |
| `@mariozechner/pi-web-ui` | `@shuv1337/shuv-web-ui` |
| binary `pi` | `shuv` |
| binary `pi-ai` | `shuv-ai` |
| binary `pi-pods` | `shuv-pods` |
| `~/.pi/` | `~/.shuv/` |
| `.pi/` | `.shuv/` |
| `PI_*` | `SHUV_*` |
| `piConfig` | `shuvConfig` |
| package.json key `"pi": {}` | `"shuv": {}` |
| `PiManifest` | `ShuvManifest` |
| `APP_NAME = "pi"` | `APP_NAME = "shuv"` |
| `CONFIG_DIR_NAME = ".pi"` | `CONFIG_DIR_NAME = ".shuv"` |
| root package `pi-monorepo` | `shuv-monorepo` |
| metadata URL `badlogic/pi-mono` | `shuv1337/pi-mono` |

### Explicit exceptions

Do **not** rename these external packages:

- `@mariozechner/jiti`
- `@mariozechner/mini-lit`
- `@mariozechner/clipboard*`

Do **not** rewrite these frozen/historical surfaces:

- released sections in `packages/*/CHANGELOG.md`
- frozen session fixtures such as `packages/coding-agent/test/fixtures/*.jsonl`

### Branding decision for this plan

Use **`shuv`** for package names, binaries, config directories, env vars, and user-facing CLI strings.

Existing `shuvcode` wording already present in the coding-agent system prompt is **not** a blocker for this rename. Leave it as-is unless a separate product-copy pass is requested.

### Share viewer URL decision

`packages/coding-agent/src/config.ts` currently defaults to `https://pi.dev/session/`.

For this rename, choose **one** of these before implementation starts:

1. Keep the old default temporarily and document it as a known branded exception, or
2. Remove the default and require `SHUV_SHARE_VIEWER_URL`.

Recommended for lowest risk: **keep the old default temporarily** and document it.

---

## Phase 0: Preflight inventory and guardrails

Before editing, capture a fresh inventory from the repo and use it as the working checklist.

### Task 0.1: Generate live inventories
- [ ] Inventory internal package specifiers: `@mariozechner/pi-*`
- [ ] Inventory live `PI_*` env vars in source/scripts/tests
- [ ] Inventory hardcoded `.pi` / `~/.pi` paths
- [ ] Inventory user-facing `pi` CLI/help text
- [ ] Inventory `pi-` branded artifact names (`dist/pi`, `pi-browser-smoke`, `pi-test.sh`, `pi-extensions`, etc.)

### Task 0.2: Define exclusions up front
- [ ] Exclude external `@mariozechner/*` fork deps listed above
- [ ] Exclude released changelog sections
- [ ] Exclude frozen JSONL fixtures unless a test truly requires an update

### Task 0.3: Validate against repo rules
- [ ] Do **not** use `npm run build` for validation
- [ ] Do **not** delete `node_modules` or lockfiles as a first step
- [ ] Do **not** auto-move `~/.pi` or project `.pi/` directories without explicit user confirmation

---

## Phase 1: Package identity and manifests

### Task 1.1: Root `package.json`
- [ ] `name: "pi-monorepo"` → `"shuv-monorepo"`
- [ ] Update root dependency `@mariozechner/pi-coding-agent` → `@shuv1337/shuv-coding-agent`

### Task 1.2: Workspace package names
Update these package names:

- [ ] `packages/ai/package.json` → `@shuv1337/shuv-ai`
- [ ] `packages/agent/package.json` → `@shuv1337/shuv-agent-core`
- [ ] `packages/coding-agent/package.json` → `@shuv1337/shuv-coding-agent`
- [ ] `packages/mom/package.json` → `@shuv1337/shuv-mom`
- [ ] `packages/pods/package.json` → `@shuv1337/shuv-pods`
- [ ] `packages/tui/package.json` → `@shuv1337/shuv-tui`
- [ ] `packages/web-ui/package.json` → `@shuv1337/shuv-web-ui`

### Task 1.3: Binary names and packaged binary output
- [ ] `packages/coding-agent/package.json` bin key `pi` → `shuv`
- [ ] `packages/ai/package.json` bin key `pi-ai` → `shuv-ai`
- [ ] `packages/pods/package.json` bin key `pi-pods` → `shuv-pods`
- [ ] Keep `packages/mom/package.json` bin key `mom`
- [ ] `packages/coding-agent/package.json` `build:binary` output `dist/pi` → `dist/shuv`

### Task 1.4: `piConfig` → `shuvConfig`
File: `packages/coding-agent/package.json`

- [ ] Rename the key `piConfig` → `shuvConfig`
- [ ] `name: "pi"` → `"shuv"`
- [ ] `configDir: ".pi"` → `".shuv"`

### Task 1.5: Internal cross-package dependencies
Update internal workspace dependencies in:

- [ ] `package.json`
- [ ] `packages/agent/package.json`
- [ ] `packages/coding-agent/package.json`
- [ ] `packages/mom/package.json`
- [ ] `packages/pods/package.json`
- [ ] `packages/web-ui/package.json`
- [ ] `packages/web-ui/example/package.json`

Do **not** touch external `@mariozechner/jiti`, `@mariozechner/mini-lit`, or `@mariozechner/clipboard*`.

### Task 1.6: Example package names and manifests
Update example package names:

- [ ] `packages/web-ui/example/package.json`: `pi-web-ui-example` → `shuv-web-ui-example`
- [ ] `packages/coding-agent/examples/extensions/sandbox/package.json`
- [ ] `packages/coding-agent/examples/extensions/with-deps/package.json`
- [ ] `packages/coding-agent/examples/extensions/custom-provider-anthropic/package.json`
- [ ] `packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/package.json`
- [ ] `packages/coding-agent/examples/extensions/custom-provider-qwen-cli/package.json`

### Task 1.7: Extension manifest key rename
Update example extension manifests from:

- [ ] `"pi": { ... }` → `"shuv": { ... }`

Apply to all example extension packages that currently expose a `pi` manifest.

### Task 1.8: Repository metadata URLs
Update `repository.url` where present:

- [ ] `packages/agent/package.json`
- [ ] `packages/ai/package.json`
- [ ] `packages/coding-agent/package.json`
- [ ] `packages/mom/package.json`
- [ ] `packages/pods/package.json`
- [ ] `packages/tui/package.json`

Use `git+https://github.com/shuv1337/pi-mono.git`.

---

## Phase 2: TypeScript path mappings and package specifiers

### Task 2.1: Root `tsconfig.json`
- [ ] Rename all `@mariozechner/pi-*` path mappings to `@shuv1337/shuv-*`
- [ ] Remove dead `@mariozechner/pi-agent-old` mappings entirely

### Task 2.2: Example tsconfig files
Update package specifiers in:

- [ ] `packages/coding-agent/tsconfig.examples.json`
- [ ] `packages/web-ui/example/tsconfig.json`

### Task 2.3: Source imports and string-literal package names
Bulk-update source imports across packages, examples, and tests:

- [ ] `@mariozechner/pi-ai` → `@shuv1337/shuv-ai`
- [ ] `@mariozechner/pi-agent-core` → `@shuv1337/shuv-agent-core`
- [ ] `@mariozechner/pi-coding-agent` → `@shuv1337/shuv-coding-agent`
- [ ] `@mariozechner/pi-mom` → `@shuv1337/shuv-mom`
- [ ] `@mariozechner/pi` → `@shuv1337/shuv-pods`
- [ ] `@mariozechner/pi-tui` → `@shuv1337/shuv-tui`
- [ ] `@mariozechner/pi-web-ui` → `@shuv1337/shuv-web-ui`

### Task 2.4: Non-import package-name strings
Also update package specifiers embedded in:

- [ ] `declare module "..."` augmentations
- [ ] `Symbol.for("@mariozechner/pi-coding-agent:...")` keys
- [ ] virtual module maps / alias maps
- [ ] README/doc snippets embedded in source comments/help output

---

## Phase 3: Runtime config, manifests, env vars, and branded storage keys

### Task 3.1: `packages/coding-agent/src/config.ts`
- [ ] `pkg.piConfig` → `pkg.shuvConfig`
- [ ] fallback app name `pi` → `shuv`
- [ ] fallback config dir `.pi` → `.shuv`
- [ ] `PI_PACKAGE_DIR` → `SHUV_PACKAGE_DIR`
- [ ] `PI_SHARE_VIEWER_URL` → `SHUV_SHARE_VIEWER_URL`
- [ ] update help/comments mentioning `~/.pi/agent`
- [ ] update download/update instruction URL to `shuv1337/pi-mono`
- [ ] apply the Phase 0 share-viewer decision

### Task 3.2: Extension manifest types and readers
Update manifest structures and accessors in:

- [ ] `packages/coding-agent/src/core/extensions/loader.ts`
- [ ] `packages/coding-agent/src/core/package-manager.ts`

Required changes:
- [ ] `PiManifest` → `ShuvManifest`
- [ ] `readPiManifest` / `readPiManifestFile` → `readShuvManifest` / `readShuvManifestFile`
- [ ] `pkg.pi` → `pkg.shuv`

### Task 3.3: Skill discovery mode rename
File: `packages/coding-agent/src/core/package-manager.ts`

- [ ] `SkillDiscoveryMode = "pi" | "agents"` → `"shuv" | "agents"`
- [ ] `mode === "pi"` → `mode === "shuv"`
- [ ] `collectAutoSkillEntries(..., "pi")` → `... "shuv"`

### Task 3.4: Hardcoded `.pi` extension discovery path
File: `packages/coding-agent/src/core/extensions/loader.ts`

- [ ] Replace `path.join(cwd, ".pi", "extensions")` with `CONFIG_DIR_NAME`
- [ ] Update associated comments from `.pi` / `pi` manifest wording to `.shuv` / `shuv`

### Task 3.5: Env vars — rename live runtime variables
Rename live code/script/test env vars:

| Old | New |
|---|---|
| `PI_API_KEY` | `SHUV_API_KEY` |
| `PI_CODING_AGENT_DIR` | `SHUV_CODING_AGENT_DIR` |
| `PI_STARTUP_BENCHMARK` | `SHUV_STARTUP_BENCHMARK` |
| `PI_OFFLINE` | `SHUV_OFFLINE` |
| `PI_SKIP_VERSION_CHECK` | `SHUV_SKIP_VERSION_CHECK` |
| `PI_PACKAGE_DIR` | `SHUV_PACKAGE_DIR` |
| `PI_SHARE_VIEWER_URL` | `SHUV_SHARE_VIEWER_URL` |
| `PI_CODING_AGENT` | `SHUV_CODING_AGENT` |
| `PI_CONFIG_DIR` | `SHUV_CONFIG_DIR` |
| `PI_AGENT_DIR` | `SHUV_AGENT_DIR` |
| `PI_CLEAR_ON_SHRINK` | `SHUV_CLEAR_ON_SHRINK` |
| `PI_HARDWARE_CURSOR` | `SHUV_HARDWARE_CURSOR` |
| `PI_DEBUG_REDRAW` | `SHUV_DEBUG_REDRAW` |
| `PI_TUI_DEBUG` | `SHUV_TUI_DEBUG` |
| `PI_TUI_WRITE_LOG` | `SHUV_TUI_WRITE_LOG` |
| `PI_CACHE_RETENTION` | `SHUV_CACHE_RETENTION` |
| `PI_AI_ANTIGRAVITY_VERSION` | `SHUV_AI_ANTIGRAVITY_VERSION` |
| `PI_NO_LOCAL_LLM` | `SHUV_NO_LOCAL_LLM` |
| `PI_IMAGE_SAVE_DIR` | `SHUV_IMAGE_SAVE_DIR` |
| `PI_IMAGE_SAVE_MODE` | `SHUV_IMAGE_SAVE_MODE` |
| `PI_SPAWN_HOOK` | `SHUV_SPAWN_HOOK` |
| `PI_WSL_CLIPBOARD_IMAGE_PATH` | `SHUV_WSL_CLIPBOARD_IMAGE_PATH` |

Do **not** invent replacements for env vars that do not exist in live code.

### Task 3.6: Files with missing env-var coverage from the original plan
Ensure these are included explicitly:

- [ ] `packages/pods/src/cli.ts`
- [ ] `packages/pods/src/commands/pods.ts`
- [ ] `packages/pods/src/commands/prompt.ts`
- [ ] `packages/pods/src/commands/models.ts`
- [ ] `packages/pods/scripts/pod_setup.sh`
- [ ] `packages/pods/scripts/model_run.sh`
- [ ] `scripts/profile-coding-agent-node.mjs`
- [ ] `packages/coding-agent/scripts/migrate-sessions.sh`

### Task 3.7: Process title and startup markers
- [ ] `packages/coding-agent/src/cli.ts`: `process.title = "pi"` → `"shuv"`
- [ ] `packages/coding-agent/src/cli.ts`: `process.env.PI_CODING_AGENT` → `SHUV_CODING_AGENT`
- [ ] `packages/coding-agent/src/bun/cli.ts`: same rename if present

### Task 3.8: API/client identifiers
Update branded identifiers sent to external services:

- [ ] `packages/ai/src/providers/openai-codex-responses.ts`: `originator = "pi"` → `"shuv"`
- [ ] `packages/ai/src/utils/oauth/openai-codex.ts`: default originator `pi` → `shuv`
- [ ] `packages/ai/test/openai-codex-stream.test.ts`: expectation updates
- [ ] `packages/ai/src/providers/google-gemini-cli.ts`: `userAgent` `pi-coding-agent` → `shuv-coding-agent`
- [ ] `packages/ai/src/providers/google-gemini-cli.ts`: requestId prefix `pi-...` → `shuv-...`

### Task 3.9: Web component / storage / export-html keys
- [ ] `packages/web-ui/src/ChatPanel.ts`: `pi-chat-panel` → `shuv-chat-panel`
- [ ] `packages/web-ui/example/src/main.ts`: IndexedDB db name `pi-web-ui-example` → `shuv-web-ui-example`
- [ ] `packages/coding-agent/src/core/export-html/template.js`: `meta[name="pi-url-params"]` → `shuv-url-params`
- [ ] `packages/coding-agent/src/core/export-html/template.js`: `meta[name="pi-share-base-url"]` → `shuv-share-base-url`
- [ ] `packages/coding-agent/src/core/export-html/template.js`: `pi-share:v1:sidebar-width` → `shuv-share:v1:sidebar-width`

### Task 3.10: Temp/cache/log/auth path names
- [ ] `packages/coding-agent/src/core/package-manager.ts`: `pi-extensions` temp/cache dir names → `shuv-extensions`
- [ ] `packages/tui/src/tui.ts`: `.pi/agent/pi-debug.log` and `pi-crash.log` → `.shuv/agent/shuv-debug.log` / `shuv-crash.log`
- [ ] `packages/mom/src/agent.ts`: `~/.pi/mom/auth.json` → `~/.shuv/mom/auth.json`
- [ ] `packages/pods/src/config.ts`: default config dir `.pi` → `.shuv`

---

## Phase 4: User-facing CLI/help/output strings and support scripts

### Task 4.1: `packages/ai/src/cli.ts`
Update all printed package-install/help text:

- [ ] `npx @mariozechner/pi-ai` → `npx @shuv1337/shuv-ai`
- [ ] package/help examples and error hints

### Task 4.2: `packages/pods/src/cli.ts`
Update all branded help text:

- [ ] banner `pi v...` → `shuv-pods v...` or equivalent chosen branding
- [ ] commands `pi pods ...` → `shuv-pods ...`
- [ ] references to `pi-agent` → `shuv` or `shuv` subcommand wording, whichever is intended
- [ ] env help text `PI_API_KEY`, `PI_CONFIG_DIR` → `SHUV_API_KEY`, `SHUV_CONFIG_DIR`

### Task 4.3: `packages/pods/src/commands/*`
Update user-facing error/help strings in:

- [ ] `packages/pods/src/commands/pods.ts`
- [ ] `packages/pods/src/commands/models.ts`
- [ ] `packages/pods/src/commands/prompt.ts`

### Task 4.4: Support scripts with branded artifact names
- [ ] `scripts/check-browser-smoke.mjs`: `pi-browser-smoke.*` → `shuv-browser-smoke.*`
- [ ] `packages/coding-agent/scripts/migrate-sessions.sh`: env/path/help text updates
- [ ] `scripts/profile-coding-agent-node.mjs`: env var names and help text updates
- [ ] `scripts/edit-tool-stats.mjs`: default session dir path strings if still branded

### Task 4.5: Test runner script rename
- [ ] rename `pi-test.sh` → `shuv-test.sh`
- [ ] update references in `README.md`, `AGENTS.md`, and `packages/coding-agent/docs/development.md`

### Task 4.6: Binary archive / artifact names
Update branded artifact names in:

- [ ] `scripts/build-binaries.sh`
- [ ] `.github/workflows/build-binaries.yml`

Required changes:
- [ ] `pi-<platform>` archives → `shuv-<platform>`
- [ ] wrapper directory name `pi` inside archives → `shuv`
- [ ] output paths and printed examples updated accordingly

---

## Phase 5: Tests, examples, docs, GitHub metadata, and theme/schema URLs

### Task 5.1: Update tests that rely on branded paths, env vars, or package names
Covers live tests in:

- [ ] `packages/coding-agent/test/**`
- [ ] `packages/coding-agent/test/suite/**`
- [ ] `packages/ai/test/**`
- [ ] `packages/tui/test/**`

Include explicit updates for:
- [ ] `.pi` / `~/.pi` paths
- [ ] `PI_*` env vars
- [ ] `pi-extensions` fixture names in `packages/coding-agent/test/git-update.test.ts`
- [ ] temp-directory prefixes like `pi-*` where branded output matters

### Task 5.2: Preserve frozen fixtures unless truly necessary
- [ ] Leave `packages/coding-agent/test/fixtures/*.jsonl` untouched unless a failing test proves they must change
- [ ] If any fixture must remain branded for historical replay, document it as an exception

### Task 5.3: Root docs
Update:

- [ ] `README.md`
- [ ] `CONTRIBUTING.md`
- [ ] `AGENTS.md`

Include:
- [ ] package names and install commands
- [ ] badge URLs and GitHub URLs
- [ ] `pi-test.sh` references
- [ ] `.pi` / `~/.pi` paths

### Task 5.4: Package READMEs and docs
Update branded content in:

- [ ] `packages/ai/README.md`
- [ ] `packages/agent/README.md`
- [ ] `packages/coding-agent/README.md`
- [ ] `packages/web-ui/README.md`
- [ ] `packages/pods/README.md`
- [ ] `packages/mom/README.md`
- [ ] `packages/coding-agent/docs/**`
- [ ] `packages/pods/docs/**`
- [ ] `packages/mom/docs/**`
- [ ] example READMEs under `packages/coding-agent/examples/**`

### Task 5.5: Theme schema URLs and metadata
Update:

- [ ] `packages/coding-agent/src/modes/interactive/theme/dark.json`
- [ ] `packages/coding-agent/src/modes/interactive/theme/light.json`
- [ ] `packages/coding-agent/examples/extensions/dynamic-resources/dynamic.json`
- [ ] `packages/coding-agent/src/modes/interactive/theme/theme-schema.json`

### Task 5.6: GitHub metadata and workflows
Review and update `.github/**` for:

- [ ] repo URLs
- [ ] archive/binary names
- [ ] issue templates linking to old org/repo
- [ ] any references to old package names in examples or release text

### Task 5.7: Changelogs
- [ ] Update only `[Unreleased]` sections if the rename needs changelog entries
- [ ] Do **not** rewrite historical released sections

---

## Phase 6: Install metadata and lockfiles

### Task 6.1: Root workspace lockfile
- [ ] Run `npm install` at the repo root after package/package-dependency renames
- [ ] Verify `package-lock.json` reflects the new internal package names

### Task 6.2: Nested example lockfiles
Update standalone example lockfiles without deleting them first:

- [ ] `packages/coding-agent/examples/extensions/custom-provider-anthropic/package-lock.json`
- [ ] `packages/coding-agent/examples/extensions/sandbox/package-lock.json`
- [ ] `packages/coding-agent/examples/extensions/with-deps/package-lock.json`

Recommended approach: run `npm install` in each affected example directory after its `package.json` rename.

### Task 6.3: Do not do destructive reset-style install steps
- [ ] Do **not** delete `node_modules`
- [ ] Do **not** delete lockfiles as part of the normal rename workflow
- [ ] Only clean/install more aggressively if a specific install inconsistency requires it and the user approves

---

## Phase 7: Validation

Validation should follow repo rules: **run `npm run check`, not `npm run build`**.

### Task 7.1: Static validation
- [ ] `npm run check`

### Task 7.2: CLI/help smoke tests from source
Recommended smoke checks:

- [ ] `npx tsx packages/ai/src/cli.ts --help`
- [ ] `npx tsx packages/pods/src/cli.ts --help`
- [ ] `npx tsx packages/coding-agent/src/cli.ts --help`

Confirm these surfaces show `shuv` branding and no stale `pi` commands.

### Task 7.3: Grep-based validation
- [ ] no remaining internal `@mariozechner/pi-*` references outside the explicit external allowlist, frozen fixtures, and historical changelog sections
- [ ] no remaining live-code `PI_*` references in source/scripts/tests
- [ ] no remaining live `.pi` / `~/.pi` paths outside migration docs/comments explicitly kept for backwards explanation
- [ ] no remaining `pi-chat-panel`, `pi-web-ui-example`, `pi-browser-smoke`, `dist/pi`, or `pi-test.sh` references in active code/docs
- [ ] dead tsconfig path `@mariozechner/pi-agent-old` removed

### Task 7.4: Focused runtime checks
- [ ] project-local config resolves from `.shuv/`
- [ ] global config resolves from `~/.shuv/agent/`
- [ ] extension discovery works from `.shuv/extensions/`
- [ ] mom auth path points at `~/.shuv/mom/auth.json`
- [ ] pods config defaults to `~/.shuv`

---

## Phase 8: Optional manual migration and rollout notes

This is **not** part of the core code-edit pass.

### Task 8.1: Manual host migration (only with explicit approval)
Possible follow-up commands:

- [ ] migrate `~/.pi` → `~/.shuv`
- [ ] migrate project `.pi/` → `.shuv/`

### Task 8.2: Release notes / upgrade notes
If this rename ships to users, document:

- [ ] new package names
- [ ] new binaries
- [ ] new config paths
- [ ] renamed env vars
- [ ] manual migration steps
- [ ] explicit exceptions (for example share viewer URL if still on `pi.dev`)

---

## Execution order

1. **Phase 0** — inventory + exclusions + guardrails
2. **Phase 1** — package identity, manifests, internal deps, examples
3. **Phase 2** — tsconfig paths, imports, module/package-name string literals
4. **Phase 3** — runtime config, manifest readers, env vars, storage keys, API identifiers
5. **Phase 4** — CLI/help/output strings and support scripts
6. **Phase 5** — tests, docs, workflows, schema URLs
7. **Phase 6** — `npm install` and lockfile refresh
8. **Phase 7** — validation via `npm run check` + smoke tests + grep assertions
9. **Phase 8** — optional manual migration / release notes

---

## Final readiness checklist

- [ ] all internal package names use `@shuv1337/shuv-*`
- [ ] root dependency on `@mariozechner/pi-coding-agent` renamed
- [ ] coding-agent binary is `shuv` and packaged binary output is `dist/shuv`
- [ ] example package names and manifest keys use `shuv`
- [ ] all tsconfig path aliases renamed; dead `pi-agent-old` alias removed
- [ ] manifest readers/types renamed from `PiManifest` / `pkg.pi` to `ShuvManifest` / `pkg.shuv`
- [ ] all live runtime `PI_*` env vars renamed to `SHUV_*`
- [ ] missed pods env var `PI_API_KEY` covered as `SHUV_API_KEY`
- [ ] missed helper scripts (`profile-coding-agent-node.mjs`, `migrate-sessions.sh`, browser smoke script) covered
- [ ] `.pi` discovery paths updated to `.shuv`
- [ ] web component name is `shuv-chat-panel`
- [ ] export-html/meta/storage keys renamed
- [ ] debug/crash log paths renamed to `.shuv/.../shuv-*.log`
- [ ] CLI/help text for ai, coding-agent, and pods no longer tells users to run `pi`
- [ ] README/AGENTS/docs no longer reference `pi-test.sh`
- [ ] root and nested lockfiles refreshed via `npm install`, without deleting them first
- [ ] `npm run check` passes
- [ ] frozen fixtures and released changelog history remain untouched unless explicitly justified
