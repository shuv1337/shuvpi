# Plan: Add Baseten as a Native Provider to the Pi Agent Harness

**Status:** implementation plan only  
**Reviewed:** 2026-06-24  
**Repository:** `shuv1337/pi-mono`  
**Code snapshot reviewed:** `main` at `3eff1ece`  
**Primary packages:** `packages/ai`, `packages/coding-agent`

## Executive decision

Implement Baseten as a native `openai-completions` model-catalog provider backed by Pi's existing generated-model, auth, API-registry, and coding-agent registry paths.

Do **not** add a new transport, directly fetch Baseten's `/v1/models` endpoint during Pi model generation, or add Baseten's beta Anthropic Messages API in the first patch.

The implementation should:

1. Register provider ID `baseten` with base URL `https://inference.baseten.co/v1` and `BASETEN_API_KEY` authentication.
2. Generate Baseten's model catalog from the existing `models.dev/api.json` source already used by Pi.
3. Add conservative OpenAI-compatibility metadata so Pi does not send unsupported OpenAI-specific fields by default.
4. Add generic chat-template compatibility maps so Pi can emit Baseten's exact `chat_template_args` request field without overloading the existing `qwen-chat-template` special case.
5. Encode model-specific reasoning controls from Baseten's official documentation rather than trusting generic `models.dev` reasoning flags blindly.
6. Add focused payload, model metadata, auth, registry, and optional live smoke tests.
7. Update the user-facing provider documentation, generated files, test environment sanitization, and changelogs.

## Corrections to the earlier assumptions

| Earlier assumption | Verified result | Consequence |
|---|---|---|
| Add a Baseten-specific `/v1/models` fetcher to `generate-models.ts`. | Pi already consumes `models.dev/api.json`, and that catalog already contains a `baseten` provider with the current Model API slugs. | Extend the existing `models.dev` processing path. Do not create a second catalog source. |
| A provider factory, registration, and env key are the complete native integration surface. | This fork does not use per-provider factories for OpenAI-compatible catalog providers. `KnownProvider`, generated `MODELS`, env-key discovery, coding-agent display names, `defaultModelPerProvider`, coding-agent compat schema/merge logic, and `test.sh` are the required surfaces. | Update all explicit lists and schemas; do not add an unused provider factory. |
| Existing `thinkingFormat: "chat-template"` can represent Baseten opt-in reasoning. | This fork currently only has hardcoded `qwen-chat-template` behavior that emits `chat_template_kwargs`. There is no generic chat-template map type yet. Baseten requires `chat_template_args`. | Add a new generic `thinkingFormat: "chat-template"` path with explicit `chatTemplateKwargs` and `chatTemplateArgs` maps. Preserve `qwen-chat-template` unless tests justify consolidating it safely. |
| All models marked as reasoning-capable by `models.dev` should stay reasoning-capable. | Baseten's official reasoning table says models not listed there do not support reasoning. | Use an official Baseten reasoning allowlist for provider-specific overrides. |
| Baseten needs a response parser for `reasoning_content`. | Pi's OpenAI-completions stream parser already handles `reasoning_content`, `reasoning`, and `reasoning_text`. | No new response parser is needed; add a regression test instead. |
| Baseten's Anthropic-compatible endpoint is another sensible native API option. | Baseten labels Anthropic Messages support beta and recommends OpenAI Chat Completions for production workloads. | Keep v1 on `openai-completions`. |
| A package export-map entry is required for `baseten.ts`. | This fork's `@shuv1337/pi-ai` export map is explicit and there is no need for a Baseten provider module. | Do not create `baseten.ts`. If a provider module is introduced later, add a package export entry deliberately. |
| Custom Baseten deployments should be part of the built-in provider. | Baseten Model APIs and user-specific Truss/dedicated deployments are separate endpoint surfaces. | Native support targets shared Model APIs only; custom endpoints remain configurable in `models.json`. |

## Verified architecture

### Provider construction

This fork represents built-in model providers through the generated aggregate catalog in `packages/ai/src/models.generated.ts`. Each generated model carries:

- `provider`
- `api`
- `baseUrl`
- model metadata
- optional compatibility metadata

Streaming implementations are registered by API type in `packages/ai/src/providers/register-builtins.ts`. Because Baseten uses the existing `openai-completions` API, adding Baseten models does not require a new stream registration or provider factory.

### Model generation

`packages/ai/scripts/generate-models.ts`:

- downloads `https://models.dev/api.json`
- filters and normalizes provider model records
- adds Pi-specific compatibility and thinking metadata
- writes `packages/ai/src/models.generated.ts`

`models.generated.ts` must be regenerated, not manually edited. This checkout does not generate per-provider `*.models.ts` files.

### Coding-agent model loading

`ModelRegistry` gets built-in providers and models directly from `@shuv1337/pi-ai` via `getProviders()` and `getModels()`. Once Baseten appears in generated `MODELS`, coding-agent does not need a separate Baseten model loader.

Coding-agent does, however, mirror compatibility configuration in a TypeBox schema and deep-merge selected nested fields. Any new compatibility property and new `thinkingFormat` literal must be added there too. This work should also fix existing schema drift for `string-thinking` and `ant-ling`.

### Current OpenAI compatibility behavior

Pi's OpenAI-completions implementation already supports:

- streamed text and tool-call deltas
- `max_tokens` versus `max_completion_tokens`
- provider-specific reasoning request formats
- `reasoning_content` parsing into thinking blocks
- hardcoded `qwen-chat-template` support that emits `chat_template_kwargs.enable_thinking`

It does **not** currently have a generic compatibility-map path for `chat_template_kwargs` or `chat_template_args`.

## Scope

### In scope

- Shared Baseten Model APIs at `https://inference.baseten.co/v1`
- Bearer authentication through `BASETEN_API_KEY`
- OpenAI Chat Completions transport
- Built-in Baseten models from `models.dev`
- Text, vision metadata, streaming, tools, usage, and reasoning support
- Exact `reasoning_effort` and `chat_template_args` request behavior
- Built-in coding-agent discovery and display
- Documentation, generated catalog, tests, and changelogs

### Out of scope for the initial patch

- Baseten's beta Anthropic Messages endpoint
- Discovery of user-specific Truss or dedicated deployments
- A direct Baseten `/v1/models` generator dependency
- A Baseten-specific API transport
- Changing Pi's default model
- Baseten-specific attribution headers unless Baseten documents a requirement
- Enabling unverified OpenAI extras such as `store`, long cache retention, or strict tool definitions

## File-by-file implementation plan

### 1. Add Baseten to the typed provider set

**File:** `packages/ai/src/types.ts`

Add `"baseten"` to `KnownProvider`.

This is required even though `Provider` also permits arbitrary strings: built-in catalog APIs and generated model types use the narrower `KnownProvider` union.

In the same file, add generic support for chat-template request fields. Add the shared value type near the compatibility types, and add the two map properties to `OpenAICompletionsCompat`:

```ts
export type ChatTemplateValue =
  | string
  | number
  | boolean
  | null
  | { $var: "thinking.enabled" }
  | { $var: "thinking.effort"; omitWhenOff?: boolean };

/** Values to send as `chat_template_kwargs` when using configurable chat-template reasoning. */
chatTemplateKwargs?: Record<string, ChatTemplateValue>;

/** Values to send as `chat_template_args` when using configurable chat-template reasoning. */
chatTemplateArgs?: Record<string, ChatTemplateValue>;
```

Recommended design:

- Add `thinkingFormat: "chat-template"`.
- Add `chatTemplateKwargs` for endpoints that expect `chat_template_kwargs`.
- Add `chatTemplateArgs` for endpoints that expect `chat_template_args`.
- Reuse one shared `ChatTemplateValue` type and these Pi variables:
  - `{ $var: "thinking.enabled" }`
  - `{ $var: "thinking.effort" }`
- Preserve existing `thinkingFormat: "qwen-chat-template"` behavior for compatibility with current local Qwen-compatible configs.

Why this design:

- It models the wire protocol exactly.
- It is reusable by custom providers.
- It avoids a provider-named `thinkingFormat: "baseten"` branch.
- It avoids pretending `chat_template_kwargs` and `chat_template_args` are interchangeable.

A more abstract `chatTemplateField` selector is possible, but two explicit maps are smaller, easier to validate, and less likely to break existing custom-provider configuration.

### 2. Emit generic chat-template fields in OpenAI Chat Completions payloads

**File:** `packages/ai/src/providers/openai-completions.ts`

Add a field-agnostic resolver, for example:

```ts
function buildChatTemplateValues(
  values: Record<string, ChatTemplateValue> | undefined,
  model: Model<"openai-completions">,
  options: OpenAICompletionsOptions | undefined,
): Record<string, unknown> | undefined
```

The helper should preserve current semantics for:

- scalar values
- `thinking.enabled`
- `thinking.effort`
- `omitWhenOff`
- thinking-level mappings

Update `ResolvedOpenAICompletionsCompat`, `detectCompat()`, and `getCompat()` so both `chatTemplateKwargs` and `chatTemplateArgs` resolve to usable maps, normally `{}`. Avoid calling `Object.entries()` on possibly undefined values.

Add a new `thinkingFormat === "chat-template"` branch:

1. Resolve `compat.chatTemplateKwargs`; emit it as `chat_template_kwargs` when non-empty.
2. Resolve `compat.chatTemplateArgs`; emit it as `chat_template_args` when non-empty.
3. Permit both fields if a custom endpoint genuinely specifies both, rather than making them mutually exclusive.

Do not change the existing `qwen-chat-template` behavior in this patch unless tests expose duplicated logic worth consolidating safely.

No new response parsing is required. The current parser already recognizes streamed `reasoning_content` and converts it to Pi thinking blocks.

### 3. Add the generated Baseten model transformation

**File:** `packages/ai/scripts/generate-models.ts`

Add Baseten constants and helpers near the existing provider-specific compatibility definitions.

#### Base URL

```ts
const BASETEN_BASE_URL = "https://inference.baseten.co/v1";
```

#### Official reasoning model sets

```ts
const BASETEN_REASONING_EFFORT_MODELS = new Set([
  "deepseek-ai/DeepSeek-V4-Pro",
  "openai/gpt-oss-120b",
]);

const BASETEN_CHAT_TEMPLATE_ARGS_MODELS = new Set([
  "moonshotai/Kimi-K2.5",
  "moonshotai/Kimi-K2.6",
  "moonshotai/Kimi-K2.7-Code",
  "zai-org/GLM-4.7",
  "zai-org/GLM-5",
  "zai-org/GLM-5.1",
  "zai-org/GLM-5.2",
  "nvidia/Nemotron-120B-A12B",
  "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B",
]);

const BASETEN_REASONING_MODELS = new Set([
  ...BASETEN_REASONING_EFFORT_MODELS,
  ...BASETEN_CHAT_TEMPLATE_ARGS_MODELS,
]);
```

Use exact, case-sensitive slugs from the provider catalog. Do not normalize them.

#### Conservative base compatibility

Start from explicit, conservative metadata rather than Pi's OpenAI defaults:

```ts
const BASETEN_BASE_COMPAT: OpenAICompletionsCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens",
  supportsStrictMode: false,
  supportsLongCacheRetention: false,
};
```

Rationale:

- Baseten documents `max_tokens` in examples.
- Baseten documents system messages, not OpenAI's newer `developer` role.
- Baseten does not document `store`, OpenAI long cache-retention controls, or strict function-definition semantics.
- Structured outputs support does not prove support for the OpenAI-specific `tools[].function.strict` field.

Treat the following as verification items rather than assumptions:

- `supportsUsageInStreaming`
- strict tool definition support
- developer role support
- `store`
- `prompt_cache_retention`

If a payload fixture or live probe proves support, enable it in a follow-up or in the same patch with a regression test.

#### Per-family reasoning compatibility

For `deepseek-ai/DeepSeek-V4-Pro`:

```ts
{
  ...BASETEN_BASE_COMPAT,
  supportsReasoningEffort: true,
  thinkingFormat: "openai",
}
```

Recommended thinking map:

```ts
{
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
}
```

For `openai/gpt-oss-120b`:

```ts
{
  ...BASETEN_BASE_COMPAT,
  supportsReasoningEffort: true,
  thinkingFormat: "openai",
}
```

Recommended thinking map:

```ts
{
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
}
```

Baseten documents reasoning as enabled by default for these two models and does not document an off value. `off: null` prevents Pi from inventing one.

For the Kimi, GLM, and Nemotron opt-in families:

```ts
{
  ...BASETEN_BASE_COMPAT,
  thinkingFormat: "chat-template",
  chatTemplateArgs: {
    enable_thinking: { $var: "thinking.enabled" },
  },
}
```

These models can represent both on and off by sending `enable_thinking: true` or `false`; no provider-specific branch is needed after the generic compatibility field is added.

For models outside the official Baseten reasoning table:

- set `reasoning: false`
- do not attach thinking controls

This matters because the current `models.dev` metadata may mark additional models as reasoning-capable, while Baseten explicitly says unlisted models do not support reasoning.

#### Transform `data.baseten.models`

Add a Baseten processing block in `loadModelsDevData()` following the existing provider-specific patterns:

1. Check `data.baseten?.models`.
2. Iterate its entries.
3. Skip models where `tool_call !== true`.
4. Skip models marked deprecated when that metadata is present.
5. Preserve the exact model ID and display name.
6. Set:
   - `api: "openai-completions"`
   - `provider: "baseten"`
   - `baseUrl: BASETEN_BASE_URL`
7. Derive `reasoning` from `BASETEN_REASONING_MODELS`, not only `m.reasoning`.
8. Preserve `models.dev` pricing, context, output limit, and input modalities using the same normalizers as the surrounding generator code.
9. Apply the per-model Baseten compatibility and thinking map.

Do not directly write generated model output in source control by hand. Run the generator and review the output.

### 4. Do not add a provider factory or API registration

No new file is needed under `packages/ai/src/providers/`.

Do not add a Baseten stream implementation, provider factory, or API registration. `packages/ai/src/providers/register-builtins.ts` already registers `openai-completions`, and Baseten models should point at that API through generated catalog metadata.

Once the generator includes Baseten, `getProviders()`, `getModels()`, and coding-agent's built-in model loading path pick it up from `packages/ai/src/models.generated.ts`.

### 5. Add environment-key discovery

**File:** `packages/ai/src/env-api-keys.ts`

Add:

```ts
baseten: "BASETEN_API_KEY",
```

This enables generic auth detection and coding-agent availability checks.

### 6. Regenerate model files

Run from `packages/ai`:

```bash
npm run generate-models
```

Expected generated changes:

- updated `packages/ai/src/models.generated.ts`

Review generated output for:

- exact provider ID and base URL
- exact case-sensitive model slugs
- only tool-capable, non-deprecated models
- correct text/image modalities
- costs and token limits populated from `models.dev`
- the official Baseten reasoning allowlist applied
- correct `reasoning_effort` versus `chat_template_args` compatibility

### 7. Mirror the new compatibility fields in coding-agent

**File:** `packages/coding-agent/src/core/model-registry.ts`

Add a schema for the new generic chat-template map values:

```ts
const ChatTemplateValueSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
  Type.Object({
    $var: Type.Union([
      Type.Literal("thinking.enabled"),
      Type.Literal("thinking.effort"),
    ]),
    omitWhenOff: Type.Optional(Type.Boolean()),
  }),
]);
```

Add both map fields to `OpenAICompletionsCompatSchema`:

```ts
chatTemplateKwargs: Type.Optional(
  Type.Record(Type.String(), ChatTemplateValueSchema),
),
chatTemplateArgs: Type.Optional(
  Type.Record(Type.String(), ChatTemplateValueSchema),
),
```

Also update the `thinkingFormat` schema to include:

- `"chat-template"`
- `"string-thinking"`
- `"ant-ling"`

The last two already exist in `packages/ai/src/types.ts`; adding them here fixes current schema drift.

Update `mergeCompat()` to deep-merge `chatTemplateKwargs` and `chatTemplateArgs`, just as it already deep-merges:

- `openRouterRouting`
- `vercelGatewayRouting`

Without the deep merge, a per-provider or per-model override could erase generated Baseten entries unexpectedly.

Add or update model-registry schema/merge tests for:

- valid `chatTemplateKwargs` and `chatTemplateArgs`
- invalid variable names rejected
- provider-level and model-level maps merged rather than replaced

### 8. Add the user-facing provider name

**File:** `packages/coding-agent/src/core/provider-display-names.ts`

Add:

```ts
baseten: "Baseten",
```

The registry falls back to the raw provider ID, but a built-in provider should have a stable display name in `/login`, model selection, and status output.

### 9. Add a default model for coding-agent provider scoping

**File:** `packages/coding-agent/src/core/model-resolver.ts`

Add `baseten` to `defaultModelPerProvider`, for example:

```ts
baseten: "moonshotai/Kimi-K2.6",
```

This is required because `defaultModelPerProvider` is a `Record<KnownProvider, string>`. Adding `"baseten"` to `KnownProvider` without this entry will fail typechecking.

Use a model ID that the Baseten generator guarantees from `models.dev` and that is suitable as a default. `moonshotai/Kimi-K2.6` is currently present, tool-capable, and image-capable in the live catalog.

### 10. Sanitize Baseten credentials in the test runner

**File:** `test.sh`

Add:

```bash
unset BASETEN_API_KEY
```

The root test runner manually removes each provider credential before invoking the workspace suite. Omitting Baseten would allow locally configured paid credentials to activate real-provider paths during tests.

### 11. Documentation

#### `packages/ai/README.md`

Add Baseten to:

- the supported provider list
- the API-key/environment variable table
- any provider/API matrix that distinguishes `openai-completions`

Document:

```text
Provider: baseten
Environment variable: BASETEN_API_KEY
API: openai-completions
Base URL: https://inference.baseten.co/v1
```

#### `packages/coding-agent/docs/providers.md`

Add a Baseten row with:

- provider ID `baseten`
- environment variable `BASETEN_API_KEY`
- native API-key auth support

Add a minimal `auth.json` example only if the document does so consistently for comparable providers.

#### `packages/coding-agent/docs/models.md`

Extend the OpenAI compatibility configuration reference:

- `chatTemplateKwargs` emits `chat_template_kwargs`
- `chatTemplateArgs` emits `chat_template_args`
- both support Pi's `thinking.enabled` and `thinking.effort` variables

This is generic functionality exposed to custom providers, so it should not be documented only as a Baseten quirk.

#### `packages/coding-agent/docs/custom-provider.md`

Update the custom-provider compatibility reference to include:

- `thinkingFormat: "chat-template"`
- `chatTemplateKwargs`
- `chatTemplateArgs`
- the existing `string-thinking` and `ant-ling` literals if the reference lists the full union

#### Changelogs

Add entries under the existing `## [Unreleased]` section:

- `packages/ai/CHANGELOG.md`: native Baseten provider, generated catalog, and `chat_template_args` compatibility support
- `packages/coding-agent/CHANGELOG.md`: Baseten model/auth discovery, default-provider selection, and custom compatibility-schema support

Do not create a second Unreleased section.

## Model and reasoning matrix to encode

The exact generated catalog should continue to follow `models.dev`, but the following reasoning behavior comes from Baseten's official Model API documentation.

| Model ID | Reasoning | Pi request control | Supported Pi levels |
|---|---|---|---|
| `deepseek-ai/DeepSeek-V4-Pro` | enabled by default | `reasoning_effort` | low, medium, high, xhigh; off/minimal unsupported |
| `openai/gpt-oss-120b` | enabled by default | `reasoning_effort` | low, medium, high; off/minimal/xhigh unsupported |
| `moonshotai/Kimi-K2.5` | opt-in | `chat_template_args.enable_thinking` | off/on; Pi effort levels all map to enabled unless Baseten later documents depth controls |
| `moonshotai/Kimi-K2.6` | opt-in | `chat_template_args.enable_thinking` | off/on |
| `moonshotai/Kimi-K2.7-Code` | opt-in | `chat_template_args.enable_thinking` | off/on |
| `zai-org/GLM-4.7` | opt-in | `chat_template_args.enable_thinking` | off/on |
| `zai-org/GLM-5` | opt-in | `chat_template_args.enable_thinking` | off/on |
| `zai-org/GLM-5.1` | opt-in | `chat_template_args.enable_thinking` | off/on |
| `zai-org/GLM-5.2` | opt-in | `chat_template_args.enable_thinking` | off/on |
| `nvidia/Nemotron-120B-A12B` | opt-in | `chat_template_args.enable_thinking` | off/on |
| `nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B` | opt-in | `chat_template_args.enable_thinking` | off/on |
| Any Baseten model not in the official table | false | none | none |

For boolean opt-in families, Pi's `minimal` through `xhigh` UI levels may all result in `enable_thinking: true`. That is accurate: Baseten documents only enable/disable for those families, not distinct depth settings.

## Tests

### A. Generated model metadata

**Recommended new file:** `packages/ai/test/baseten-models.test.ts`

Model it on existing provider-specific model tests such as `packages/ai/test/together-models.test.ts`.

Cover:

1. `baseten` appears in built-in providers.
2. Every Baseten model has:
   - `provider === "baseten"`
   - `api === "openai-completions"`
   - `baseUrl === "https://inference.baseten.co/v1"`
3. The generated catalog contains only tool-capable models selected by the generator.
4. Exact model IDs preserve casing.
5. DeepSeek V4 Pro supports `xhigh`; GPT OSS 120B does not.
6. Both always-on models mark `off` unsupported.
7. Kimi, GLM, and Nemotron models use `chatTemplateArgs.enable_thinking`.
8. Models outside the official reasoning allowlist have `reasoning === false` and no thinking compatibility.
9. Vision input metadata matches the generated source catalog.

Avoid asserting an exact total model count unless the test is intentionally a catalog-snapshot test; provider catalogs change frequently. Prefer asserting required IDs and invariants.

### B. Payload serialization

**Recommended new file:** `packages/ai/test/openai-completions-chat-template-args.test.ts`

Use Pi's existing test request interception or `onPayload` hook to assert the serialized body without calling Baseten.

Cases:

1. Opt-in reasoning enabled:

```json
{
  "chat_template_args": { "enable_thinking": true }
}
```

2. Reasoning disabled:

```json
{
  "chat_template_args": { "enable_thinking": false }
}
```

3. The payload does **not** contain `chat_template_kwargs` for Baseten models.
4. DeepSeek V4 Pro sends the selected `reasoning_effort` and no chat-template field.
5. GPT OSS 120B rejects/omits `xhigh` according to its thinking map.
6. Baseten uses `max_tokens`, not `max_completion_tokens`.
7. Conservative compatibility suppresses unsupported fields:
   - no `store`
   - no long cache-retention fields
   - no `strict` on tool definitions
8. Existing `qwen-chat-template` behavior remains unchanged and passing.

### C. Response parsing regression

Add a fixture or focused test proving that a streamed Baseten-style delta containing `reasoning_content` produces a Pi `thinking_delta` and that normal `content` remains a separate text block.

This is a regression test for an existing generic parser, not a new Baseten parser.

### D. Authentication and built-in catalog registration

Update or extend:

- `packages/ai/test/env-api-keys.test.ts`
- `packages/ai/test/providers.test.ts`
- relevant runtime/generated-model tests

Cover:

- `findEnvKeys("baseten", { BASETEN_API_KEY: "..." })`
- `getEnvApiKey("baseten", ...)`
- built-in provider/model lookup through `getProviders()` and `getModels("baseten")`
- Baseten model base URL, API type, and model collection invariants

### E. Coding-agent schema and merge behavior

Update coding-agent model-registry tests to cover:

- valid `chatTemplateKwargs` and `chatTemplateArgs` in `models.json`
- invalid `$var` rejected
- deep merge across generated compat, provider override, and model override
- Baseten display name
- Baseten default model entry in `defaultModelPerProvider`
- Baseten models available only when auth is configured under existing availability semantics

Use the faux provider in `packages/coding-agent/test/suite`. Do not call Baseten from coding-agent tests.

### F. Optional gated live smoke tests

A real-provider smoke test is useful but must be optional and isolated in `packages/ai`.

Run only when `BASETEN_API_KEY` is intentionally present. Cover:

1. streamed plain text plus terminal usage
2. one tool-call round trip
3. one `reasoning_effort` model
4. one `chat_template_args` model
5. optionally a small vision request for a catalog model marked image-capable

Keep prompts tiny and cap output tokens to reduce cost. Never place this in the default no-credential test path.

## Pre-merge API probes

Before enabling optimistic compatibility flags, make minimal direct requests against one Baseten model and record the result in tests or PR notes.

Probe:

1. Does streaming accept `stream_options: { include_usage: true }` and return the expected terminal usage chunk?
2. Does the endpoint accept a `developer` message role?
3. Does it accept `store: false`?
4. Does it accept `tools[].function.strict`?
5. Does it accept `prompt_cache_retention`?
6. For tool calls followed by tool results, does it require a tool-result `name` or an assistant bridge message?
7. Does an always-on reasoning model reject an invented off value, confirming `off: null`?

The merge should not be blocked by optional capabilities. Leave them disabled if the answer is unknown.

## Implementation sequence

1. Add `baseten` to `KnownProvider`.
2. Add generic `chatTemplateKwargs` and `chatTemplateArgs` types and payload support.
3. Mirror `chatTemplateKwargs` and `chatTemplateArgs` in coding-agent schema and merge logic, including `thinkingFormat` schema drift fixes.
4. Add Baseten generator constants, model sets, compatibility helpers, and `data.baseten.models` transformation.
5. Add `BASETEN_API_KEY` to env discovery.
6. Add the coding-agent display name.
7. Add the Baseten default model in `defaultModelPerProvider`.
8. Add `unset BASETEN_API_KEY` to `test.sh`.
9. Regenerate models.
10. Add focused unit and payload tests.
11. Update provider/model docs, custom-provider docs, and changelogs.
12. Run focused tests, then the repository-prescribed checks.
13. Optionally run the gated live smoke test.

## Repository-prescribed validation commands

Install dependencies only if the checkout is not hydrated:

```bash
npm install --ignore-scripts
```

Regenerate the catalog:

```bash
cd packages/ai
npm run generate-models
cd ../..
```

Run focused Pi AI tests from `packages/ai`:

```bash
cd packages/ai
node ../../node_modules/vitest/dist/cli.js --run test/baseten-models.test.ts
node ../../node_modules/vitest/dist/cli.js --run test/openai-completions-chat-template-args.test.ts
node ../../node_modules/vitest/dist/cli.js --run test/env-api-keys.test.ts
node ../../node_modules/vitest/dist/cli.js --run test/providers.test.ts
cd ../..
```

Run any modified coding-agent test files using the same focused Vitest pattern from that package.

Run the no-credential workspace test path:

```bash
./test.sh
```

Run repository checks:

```bash
npm run check
```

Per the repository instructions:

- do not run `npm run build` unless explicitly requested
- do not use full direct Vitest invocation when focused tests suffice
- do not put real provider calls in coding-agent's suite
- do not edit generated model files manually

## Acceptance criteria

The patch is complete when all of the following hold:

- `baseten` is a typed built-in provider.
- `BASETEN_API_KEY` is detected through Pi's standard auth path.
- Baseten models appear in built-in model APIs and coding-agent model selection.
- The display name is `Baseten`, not the raw provider ID.
- `defaultModelPerProvider.baseten` points at a generated Baseten model.
- `packages/ai/src/models.generated.ts` is reproducible from `npm run generate-models`.
- Exact model slugs, pricing, limits, and modalities come from the established `models.dev` source.
- Provider-specific reasoning support follows Baseten's official model table.
- DeepSeek V4 Pro and GPT OSS 120B use `reasoning_effort` with correct level restrictions.
- Kimi, GLM, and Nemotron opt-in models emit `chat_template_args.enable_thinking`.
- Baseten payloads do not accidentally emit `chat_template_kwargs`.
- `reasoning_content` streams into Pi thinking blocks.
- `max_tokens` is used.
- Unverified OpenAI extras remain disabled.
- Tool streaming and a tool-result follow-up pass fixture tests.
- `test.sh` cannot inherit a developer's Baseten credential.
- Focused tests, `./test.sh`, and `npm run check` pass.
- Documentation and both relevant changelogs are updated.

## Risks and mitigations

### Catalog drift

Baseten's hosted catalog changes quickly, and `models.dev` may lag.

**Mitigation:** follow Pi's existing single catalog source, regenerate normally, and keep Baseten-specific wire behavior in small explicit model sets. Do not create a competing fetch path.

### Metadata disagreement

Generic metadata may claim reasoning for models that Baseten's own docs exclude.

**Mitigation:** provider official documentation wins for provider-specific capabilities. Add a regression test for the allowlist.

### Silent reasoning failure

Sending `chat_template_kwargs` instead of `chat_template_args` would likely produce valid text responses with reasoning silently disabled.

**Mitigation:** assert the exact serialized field name and absence of the wrong field.

### Overstated OpenAI compatibility

“OpenAI-compatible” does not imply support for every current OpenAI extension.

**Mitigation:** begin with conservative compatibility flags and enable optional behavior only after a fixture or endpoint probe.

### Always-on reasoning semantics

Pi exposes an `off` choice, but Baseten does not document a disable value for DeepSeek V4 Pro or GPT OSS 120B.

**Mitigation:** use `off: null` so Pi knows that off is unsupported instead of fabricating `none` or another value.

### Custom deployment confusion

A user may expect the built-in provider to discover private Baseten deployments.

**Mitigation:** state clearly in docs that native support targets Model APIs. Continue supporting private/custom endpoints through `models.json` overrides or custom providers.

## Suggested PR decomposition

A single PR is reasonable because the provider depends on the new generic compatibility field. Keep commits separable:

1. `feat(ai): support chat_template_args compatibility payloads`
2. `feat(ai): add Baseten catalog provider and generated models`
3. `feat(coding-agent): expose Baseten provider and compat config`
4. `test/docs: cover and document Baseten integration`

If reviewers prefer smaller changes, land generic chat-template payload support first, then the Baseten catalog patch. Do not land the provider with opt-in reasoning knowingly broken.

## Sources reviewed

### Pi codebase

- Repository: local checkout `/home/shuv/repos/pi-mono`
- Generated model catalog: `packages/ai/src/models.generated.ts`
- Model catalog accessors: `packages/ai/src/models.ts`
- Built-in API registration: `packages/ai/src/providers/register-builtins.ts`
- Provider and compatibility types: `packages/ai/src/types.ts`
- OpenAI Chat Completions transport: `packages/ai/src/providers/openai-completions.ts`
- Environment-key discovery: `packages/ai/src/env-api-keys.ts`
- Model generator: `packages/ai/scripts/generate-models.ts`
- Coding-agent model registry/schema: `packages/coding-agent/src/core/model-registry.ts`
- Coding-agent provider defaults: `packages/coding-agent/src/core/model-resolver.ts`
- Coding-agent display names: `packages/coding-agent/src/core/provider-display-names.ts`
- Coding-agent provider docs: `packages/coding-agent/docs/providers.md`
- Coding-agent model docs: `packages/coding-agent/docs/models.md`
- Coding-agent custom provider docs: `packages/coding-agent/docs/custom-provider.md`
- Root test wrapper: `test.sh`
- Repository contribution instructions: `AGENTS.md`

### Provider metadata and API behavior

- Models.dev API catalog: https://models.dev/api.json
- Baseten Model APIs overview: https://docs.baseten.co/inference/model-apis/overview
- Baseten reasoning controls: https://docs.baseten.co/inference/model-apis/reasoning
