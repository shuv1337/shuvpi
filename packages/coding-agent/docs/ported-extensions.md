# Ported extension sources

The selected Shuvpi extension ports derive from the `pi-shuv` source bundle at commit `f98c53b519456836e28f026eae866369fe45246b`, recorded in the fork's `packages/coding-agent/vendor/pi-shuv/VENDOR.md`. The audited fork snapshot is `69da6d8c1a57a1cfe84356837b935bfe5d67dc4d`.

The source files are adapted to the upstream 1.0 extension and model APIs. The original bundle is not loaded alongside them.

| Port | Original bundle directory |
| --- | --- |
| Questionnaire | `vendor/ask-questions` |
| Diff renderer | `vendor/diff-renderer` |
| Incremental workflow | `vendor/pi-auto-trees` |
| Open in editor | `vendor/pi-open-in-editor` |
| Powerline footer, sticky shell, prompt history | `vendor/powerline-footer` |

The incremental workflow retains the [pi-auto-trees MIT notice](licenses/pi-auto-trees.LICENSE). These notices are included in the coding-agent package's documentation directory.

## Optional extensions

The CLI defaults are defined in `src/extensions/index.ts`; the built-in set includes llama.cpp, codemode, tool search, MCP, questionnaire, background jobs, skill browser, Powerline, and workflow. Optional extensions are not loaded unless selected. `--extension` takes a local extension file, so create a small entry file that imports the published factory:

```sh
mkdir -p ~/.shuvpi/extensions
cat > ~/.shuvpi/extensions/fast-mode.ts <<'EOF'
import { createFastModeExtension } from "@shuv1337/shuvpi-coding-agent/extensions/fast-mode";
export default createFastModeExtension();
EOF
shuvpi --extension ~/.shuvpi/extensions/fast-mode.ts --fast-models openai/model-id
```

`/fast [on|off|status]` only applies priority mode to an explicitly allowlisted OpenAI Responses model; the setting resets with each session. `/preferred-model <provider>` selects an available model for the current session. Its startup preference only applies to a fresh session when no model, scoped-model, resume, or stored default overrides it. These optional commands do not change saved model defaults.

Package consumers can also import `createFastModeExtension` from `@shuv1337/shuvpi-coding-agent/extensions/fast-mode` or `createPreferredModelsExtension` from `@shuv1337/shuvpi-coding-agent/extensions/preferred-models`, or import either factory from the package root.

The Claude subagent backend requires `@anthropic-ai/claude-agent-sdk` at runtime. npm installs declare the SDK as an optional dependency; standalone Bun users must keep the SDK package beside the executable when enabling that backend.
