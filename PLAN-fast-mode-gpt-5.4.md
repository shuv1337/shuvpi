## Goal

Add a `/fast` toggle in pi that enables OpenAI priority processing for GPT-5.4 models with the smallest clean implementation.

## Decision summary

- Fast mode should be implemented in `packages/coding-agent`, not in `packages/ai`, for the first version.
- The OpenAI control is not a custom HTTP header. The actual request field is `service_tier: "priority"`.
- `packages/ai` already supports this for OpenAI Responses models:
  - `packages/ai/src/providers/openai-responses.ts` already exposes `serviceTier`
  - it already serializes to `service_tier`
  - it already reads response tier metadata and adjusts pricing
- The missing work is in pi’s session/UI/runtime layer.
- V1 should be:
  - session-local
  - default off
  - not persisted to settings
  - not written into session JSONL
- Scope V1 to GPT-5.4 priority-eligible OpenAI models only, with conservative gating.

## Why this shape is the cleanest

- Avoids widening the generic `SimpleStreamOptions` surface just for a pi-only UX toggle.
- Avoids new settings schema and `/settings` UX for a billing-sensitive option.
- Avoids session format changes and resume-time surprises.
- Uses the existing `onPayload` hook in `packages/coding-agent/src/core/sdk.ts`, which is already the final request mutation point before provider dispatch.

## Relevant code references

### Existing OpenAI priority-processing support

- `packages/ai/src/providers/openai-responses.ts`
- `packages/ai/src/providers/openai-responses-shared.ts`
- `packages/ai/src/providers/simple-options.ts`
- `packages/ai/src/types.ts`
- `packages/ai/src/models.generated.ts`
- `packages/ai/src/models.ts`

### Coding-agent runtime and request wiring

- `packages/coding-agent/src/core/sdk.ts`
- `packages/agent/src/agent.ts`
- `packages/agent/src/agent-loop.ts`

### Interactive command/UI surface

- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/slash-commands.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/coding-agent/src/modes/interactive/components/footer.ts`
- `packages/coding-agent/src/core/settings-manager.ts`
- `packages/coding-agent/src/core/session-manager.ts`

### Tests likely affected

- `packages/coding-agent/test/sdk-session-manager.test.ts`
- `packages/coding-agent/test/interactive-mode-status.test.ts`
- `packages/coding-agent/test/footer-width.test.ts`
- `packages/coding-agent/test/suite/harness.ts`
- `packages/coding-agent/test/suite/agent-session-runtime.test.ts`
- `packages/ai/test/faux-provider.test.ts`

## Functional specification

### User-facing behavior

Support these commands in interactive mode:

- `/fast` — toggle on/off
- `/fast on`
- `/fast off`
- `/fast status` — optional but recommended for clarity

### Semantics

- When enabled, pi should request priority processing by setting `service_tier: "priority"` on outgoing OpenAI Responses payloads.
- Fast mode should only apply when the current model is an eligible OpenAI GPT-5.4 model.
- If the user enables `/fast` on an unsupported model, pi should not silently lie; it should either:
  - refuse with a status/error message, or
  - store the flag but clearly indicate it is inactive until the user switches to a supported model.

Recommended V1 behavior: **reject enabling on unsupported models** and keep the state unchanged.

### Supported models for V1

Conservative initial allowlist:

- `openai/gpt-5.4`
- `openai/gpt-5.4-mini`

Possible follow-up after verification:

- `openai/gpt-5.4-pro`
- other providers/endpoints that expose `service_tier`

### Persistence

V1 should **not** persist fast mode in:

- `settings.json`
- session entries / JSONL
- project settings

Fast mode should reset to off when a new runtime/session is created.

## Implementation plan

### Phase 1 — add session-local fast-mode state

- [x] Add session-local runtime state to `packages/coding-agent/src/core/agent-session.ts`
  - [x] Add a private boolean field for fast mode, default `false`
  - [x] Add `get fastMode(): boolean`
  - [x] Add `setFastMode(enabled: boolean): void`
  - [x] Add `toggleFastMode(): boolean`
- [x] Add a small support helper in `AgentSession` or a nearby utility:
  - [x] `supportsFastMode(model)`
  - [x] `isFastModeActiveForCurrentModel()`
- [x] Keep this state out of `SettingsManager` and `SessionManager`

Validation:

- [x] Session object can toggle fast mode without touching settings or session persistence
- [x] New session starts with fast mode off

### Phase 2 — payload mutation at the correct boundary

- [x] Update `packages/coding-agent/src/core/sdk.ts`
- [x] Extend the existing `onPayload` flow so coding-agent can inject priority processing before provider dispatch
- [x] Add a helper that mutates outgoing payloads only when all of the following are true:
  - [x] session fast mode is enabled
  - [x] current model is an eligible OpenAI GPT-5.4 model
  - [x] payload shape is compatible with OpenAI Responses requests
- [x] Set:

```json
{
  "service_tier": "priority"
}
```

- [x] Preserve existing extension hook behavior:
  - [x] apply pi’s fast-mode mutation first
  - [x] then pass payload through `before_provider_request` extension hooks
  - [x] allow extensions to override the field if they want

Validation:

- [x] Outgoing OpenAI Responses payload contains `service_tier: "priority"` only when fast mode is active
- [x] Non-OpenAI payloads are unchanged
- [x] Unsupported models are unchanged

### Phase 3 — add `/fast` built-in command

- [x] Add `/fast` to `packages/coding-agent/src/core/slash-commands.ts`
- [x] Implement command handling in `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- [x] Support these cases:
  - [x] `/fast`
  - [x] `/fast on`
  - [x] `/fast off`
  - [x] `/fast status`
- [x] Emit clear user feedback messages for:
  - [x] enabled
  - [x] disabled
  - [x] already enabled/disabled
  - [x] unsupported current model
  - [x] invalid usage

Recommended usage text:

```text
Usage: /fast [on|off|status]
```

Validation:

- [x] Command appears in slash-command discovery/autocomplete
- [x] Command updates only session-local state
- [x] Invalid input shows clear help text

### Phase 4 — footer/status polish

- [x] Update `packages/coding-agent/src/modes/interactive/components/footer.ts`
- [x] Show a compact indicator when fast mode is enabled and active for the current model
- [x] Keep the footer width logic stable; avoid introducing truncation regressions

Recommended display shape:

- `gpt-5.4 • fast • medium`
- or `gpt-5.4 • priority • medium`

Prefer `fast` for user-facing consistency with `/fast`.

Validation:

- [x] Footer indicator appears only when relevant
- [x] Footer remains readable at narrow widths
- [x] Provider prefix logic still truncates correctly

### Phase 5 — tests

- [x] Add targeted coding-agent tests for session-local fast-mode state
- [x] Add tests for payload mutation behavior in `sdk.ts`
- [x] Add interactive command tests for `/fast`
- [x] Add footer rendering tests if footer indicator is implemented
- [x] Reuse faux-provider/harness patterns; do not use real API calls

Recommended test coverage:

- [x] toggling `/fast` flips session state
- [x] `/fast on` on unsupported model does not inject `service_tier`
- [x] `/fast on` on `openai/gpt-5.4` injects `service_tier: "priority"`
- [x] `/fast off` removes the behavior
- [x] fast mode is not persisted into session restore/settings
- [x] extension `before_provider_request` hooks still run after fast-mode mutation

## Suggested implementation details

### Helper placement

Prefer a tiny helper under `packages/coding-agent/src/core/` such as:

- `fast-mode.ts`

with functions like:

```ts
export function supportsFastMode(model: Model<any> | undefined): boolean
export function applyFastModeToPayload(payload: unknown, model: Model<any> | undefined, enabled: boolean): unknown
```

This keeps the logic out of `interactive-mode.ts` and out of `sdk.ts` inline closures.

### Gating logic

Recommended predicate for V1:

- provider must be `openai`
- api must be `openai-responses`
- model id must be one of:
  - `gpt-5.4`
  - `gpt-5.4-mini`

Do not key off substring-only matching for the first version unless necessary.

### Error-handling policy

If `/fast on` is attempted on an unsupported model:

- keep fast mode disabled
- show a warning/status message such as:

```text
Fast mode is only available for supported OpenAI GPT-5.4 models.
```

## Explicit non-goals for V1

- [x] Do not add a global `settings.json` field
- [x] Do not add `/settings` menu integration
- [x] Do not persist fast mode into session JSONL
- [x] Do not broaden `@mariozechner/pi-ai` public generic simple-stream API unless needed later
- [x] Do not add CLI flags such as `--fast` yet
- [x] Do not add RPC/SDK command surface unless requested separately

## Follow-up options after V1

### Option A — promote to a general service-tier abstraction

If fast mode proves useful beyond GPT-5.4, consider later:

- adding a provider-agnostic `serviceTier?: "default" | "priority" | "flex"` concept to pi-ai simple options
- exposing it through SDK and RPC
- optionally adding persistence in settings

This should be a separate cleanup/design pass, not part of the smallest clean V1.

### Option B — add `/settings` integration later

If users want a persistent UI switch:

- add a billing-sensitive warning in the settings description
- persist only after an explicit product decision

## Validation commands

After implementation:

- [x] Run from repo root:

```bash
npm run check
```

- [x] Run any new/updated targeted tests from the package root:

```bash
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/<specific-test-file>.ts
```

## Acceptance criteria

- [x] `/fast` exists in interactive mode
- [x] enabling fast mode on supported GPT-5.4 OpenAI models injects `service_tier: "priority"`
- [x] fast mode does nothing for unsupported models
- [x] the implementation does not require changes to `packages/ai` for V1
- [x] fast mode is session-local and non-persistent
- [x] existing extension request hooks continue to work
- [x] `npm run check` passes
