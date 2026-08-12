# "GPT Daybreak Blue" — primary-source research

Date of research: 2026-08-12. All claims below carry a URL and a note on what that URL shows.

## Executive summary

**"Daybreak Blue" is real and has distinct API and ChatGPT Codex identifiers.** OpenAI ships the
documented direct-API alias `daybreak-blue-latest` (an access-gated alias that resolves to
`gpt-5.6-sol`), announced in August 2026 as one of two access tiers in the OpenAI Daybreak
cybersecurity program. An authenticated OpenAI Codex `/models` catalog fetched on 2026-08-12
reports the separate ChatGPT/Codex slug `gpt-daybreak-blue-latest`, with cyber-specialty metadata,
a 272,000-token context window, and low through ultra reasoning efforts.

## Verified direct-API facts

### 1. Model ID string(s)

- `daybreak-blue-latest` is the alias. Its snapshot/alias list resolves to `gpt-5.6-sol`.
  - https://developers.openai.com/api/docs/models/daybreak-blue-latest — model page titled
    "Daybreak Blue", Snapshots section lists `daybreak-blue-latest` → `gpt-5.6-sol`.
  - https://developers.openai.com/api/docs/changelog — Aug 7, 2026 entry tagged with the literal
    model IDs `gpt-5.6-cyber`, `daybreak-red-latest`, `daybreak-blue-latest`, endpoint `v1/responses`.
- Sibling: `daybreak-red-latest` → `gpt-5.6-cyber`, 400,000 context window.
  - https://developers.openai.com/api/docs/models/daybreak-red-latest
- **No `gpt-daybreak-blue*` string exists in OpenAI's docs, model index, changelog, or pricing page.**
  The prefix is `daybreak-`, not `gpt-daybreak-`.
  - https://developers.openai.com/api/docs/models/all — "OpenAI Daybreak" section lists exactly
    three entries: GPT-5.6 Cyber, Daybreak Red, Daybreak Blue.

### 2. Endpoints

Chat Completions (`v1/chat/completions`), Responses (`v1/responses`), Realtime, Assistants, Batch,
and others are listed on the model page; the changelog entry tags the launch specifically with
`v1/responses`.
- https://developers.openai.com/api/docs/models/daybreak-blue-latest (Endpoints section)
- https://developers.openai.com/api/docs/changelog (Aug 7, 2026)

### 3. Context window and max output

- 1,050,000 context window; 128,000 max output tokens; knowledge cutoff Feb 16, 2026; reasoning
  token support.
  - https://developers.openai.com/api/docs/models/daybreak-blue-latest

### 4. Reasoning effort

- The `daybreak-blue-latest` page itself states only "Reasoning token support" and "Reasoning:
  Highest" — **it does not enumerate effort values.**
- The underlying model it aliases, `gpt-5.6-sol`, documents: `reasoning.effort` supports
  `none`, `low`, `medium` (default), `high`, `xhigh`, `max`.
  - https://developers.openai.com/api/docs/models/gpt-5.6-sol
- Treat the effort list as inherited-by-alias, not separately attested for `daybreak-blue-latest`.

### 5. Tool support

Per https://developers.openai.com/api/docs/models/daybreak-blue-latest:
- Modalities: text in/out, **image input** supported; audio and video not supported.
- Features: streaming, function calling, structured outputs — all supported. Fine-tuning not supported.
- Responses-API tools all supported: web search, file search, image generation, code interpreter,
  hosted shell, apply patch, Skills, computer use, MCP, tool search.

### 6. Pricing

- **No price is published on the `daybreak-blue-latest` model page** (the page has no Price field,
  unlike `gpt-5.6-sol`). It links out to the pricing page and to the Daybreak program application.
- The pricing page carries a "Cyber models / Our latest Daybreak models" table (per 1M tokens):
  - `gpt-5.6-sol` — short context: $5.00 input / $0.50 cached input / $6.25 cache write / $30.00
    output; long context: $10.00 / $1.00 / $12.50 / $45.00.
  - `gpt-5.6-cyber` — $12.50 / $1.25 / $15.625 / $75.00; no long-context row.
  - https://developers.openai.com/api/docs/pricing
- The alias `daybreak-blue-latest` is not itself a priced row; the effective rate is the
  `gpt-5.6-sol` rate.

### 7. Access requirements

- "This model requires separate approval and provisioning" — model page.
  https://developers.openai.com/api/docs/models/daybreak-blue-latest
- OpenAI announcement: access controlled through "identity verification, account security,
  monitoring, approved-use restrictions, and legal attestations"; available to approved individuals
  and organizations conducting authorized work.
  https://openai.com/index/expanding-daybreak-as-the-cyber-defense-window-narrows/
- Hardware security keys required on **all individual Daybreak accounts beginning September 1, 2026**
  (same URL).
- Rate limits are tier-scoped and **not supported on the Free tier**; Tier 1 = 500 RPM / 500K TPM up
  to Tier 5 = 15,000 RPM / 40M TPM.
  https://developers.openai.com/api/docs/models/daybreak-blue-latest
- Also reachable via Amazon Bedrock using the `bedrock-mantle` endpoint, US East (N. Virginia),
  still gated on Daybreak Access enrollment.
  https://openai.com/index/daybreak-models-are-now-available-on-aws/
  https://aws.amazon.com/blogs/machine-learning/accelerate-cyber-defense-with-openai-and-aws-daybreak-red-daybreak-blue-now-available-to-eligible-customers-on-amazon-bedrock/
- Governance framework (Trusted Access for Cyber): approval is not automatic; access is for
  authorized internal defensive work only, may not be resold or extended to third parties.
  https://help.openai.com/en/articles/20001258-openai-daybreak-trusted-access-for-cyber-overview

### 8. Safety / usage-policy constraints specific to Daybreak Blue

From https://openai.com/index/expanding-daybreak-as-the-cyber-defense-window-narrows/:
- Daybreak Blue **removes the system-level safeguards** that screen cybersecurity-related requests,
  for verified users. It does not change the model weights.
- Model-level refusals remain: on OpenAI's internal Advanced Cybersecurity Completion Rate eval,
  GPT-5.6 Sol under Daybreak Blue completes 2.0% of advanced dual-use requests (vs 1.5% with
  standard safeguards, 95.0% for GPT-5.6-Cyber under Daybreak Red).
- Codex-specific guidance: OpenAI "strongly encourag[es] Daybreak customers using Codex to switch
  from full-access mode to auto-review mode," plus sandboxing, scoped permission profiles, and
  explicit scope definition.
- Preparedness Framework: GPT-5.6 Sol assessed **High** for cybersecurity capability, below Critical.
- Cyber Abuse Policy applies (per the Help Center Trusted Access article above).

## Verified ChatGPT / Codex backend facts

An authenticated `codex debug models` refresh on 2026-08-12 queried OpenAI's active remote model
catalog and returned this account-authorized entry:

- Slug: `gpt-daybreak-blue-latest`
- Display name: `Daybreak Blue`
- Description: "Latest frontier agentic coding model for broad defensive cybersecurity work."
- Specialty: `cyber`
- Context and maximum context window: 272,000 tokens
- Input modalities: text and image
- Default reasoning effort: `low`
- Supported reasoning efforts: `low`, `medium`, `high`, `xhigh`, `max`, `ultra`
- Picker visibility: listed; API support: true

Reproduction command:

```sh
codex debug models | jq '.models[] | select(.slug == "gpt-daybreak-blue-latest")'
```

This remote catalog is the primary runtime source used by OpenAI's Codex client. The slug does not
appear in the public API docs because those docs describe the direct API identifier
`daybreak-blue-latest`. It also does not need to appear in the Codex source tree: Codex derives its
model list from the authenticated remote `/models` catalog rather than hardcoding model slugs.

## What was searched

Searched:
- `developers.openai.com/api/docs/models/all` — full model index; the OpenAI Daybreak section has
  no `gpt-daybreak-*` entry.
- `developers.openai.com/api/docs/changelog` — full changelog back through March 2026; the only
  Daybreak entry (Aug 7, 2026) names `daybreak-blue-latest` / `daybreak-red-latest` / `gpt-5.6-cyber`.
- `developers.openai.com/api/docs/pricing` (and `.md` source) — no `gpt-daybreak-*` row.
- Model pages for `daybreak-blue-latest`, `daybreak-red-latest`, `gpt-5.6-sol`.
- `openai.com/index/expanding-daybreak-as-the-cyber-defense-window-narrows/` and
  `openai.com/index/daybreak-models-are-now-available-on-aws/` — announcements use the prose names
  "Daybreak Blue" / "Daybreak Red", never "GPT Daybreak Blue".
- `github.com/openai/codex` full clone, full history: `grep -ri daybreak` → 0 hits;
  `git log --all -S"daybreak" -i` → 0 commits. Repo-wide grep for `cyber` in Markdown → only two
  app-server protocol lines about cyber-safety rerouting and `trustedAccessForCyber` verification.
- Codex docs pages `developers.openai.com/codex/concepts/cyber-safety`,
  `/codex/agent-approvals-security` — cover Trusted Access and auto-review, no Daybreak model slugs.
- The authenticated Codex remote catalog via `codex debug models` — confirms the
  `gpt-daybreak-blue-latest` ChatGPT/Codex slug and its runtime metadata.

Conclusion: the product/tier is real and well documented. The canonical direct API identifier is
`daybreak-blue-latest`; the authenticated ChatGPT Codex catalog uses
`gpt-daybreak-blue-latest`. Harnesses must select the identifier that matches their authentication
and endpoint path.

## Coding-agent harness support requirements

Note: for **Codex itself**, most of this is already built. Evidence from the cloned repo:

1. **No model-registry entry is needed.** Codex derives its model list from the backend catalog
   (`ModelsResponse` → `ModelInfo` → `ModelPreset`). See
   `codex-rs/models-manager/src/model_presets.rs` (hardcoded presets removed) and
   `codex-rs/models-manager/src/manager.rs` (`get_remote_models`, `build_available_models`,
   `refresh_if_new_etag`, ETag-cached `/models` fetch). A Daybreak-entitled account should simply
   see the model appear once the backend catalog returns it.
2. **Cyber-model handling already exists.** `codex-rs/protocol/src/openai_models.rs:36` defines
   `pub const MODEL_SPECIALTY_CYBER: &str = "cyber";`, and both `ModelInfo` and `ModelPreset` carry
   an `Option<String> model_specialty` field. Consumers:
   - `codex-rs/tui/src/app/thread_settings.rs` — selecting a cyber-specialty model auto-defaults the
     thread to a workspace-write permission profile plus auto-review, emitting
     `AppEvent::CyberModelAutoReviewNotice`.
   - `codex-rs/tui/src/chatwidget/permission_popups.rs` — the "Enable full access?" dialog shows an
     extra red warning ("Cyber models carry a higher risk of dangerous actions") and steers the user
     to "Approve for me" / "Ask for approval".
   - `codex-rs/core/tests/suite/cyber_exec_policy.rs` — exec-policy tests keyed on
     `ModelSpecialty::Cyber` vs `General`, asserting a different Guardian-review count.
3. **Reasoning effort is catalog-driven, not hardcoded.** `ReasoningEffort` in
   `openai_models.rs` enumerates `none | minimal | low | medium (default) | high | xhigh | max |
   ultra` plus a `Custom(String)` variant explicitly for "a model-defined effort value that this
   client does not know yet." `ModelPreset.default_reasoning_effort` and
   `supported_reasoning_efforts` come from the backend. A third-party harness copying this pattern
   should mirror the forward-compatible `Custom` escape hatch.
4. **Rerouting / verification signalling.** `codex-rs/app-server/README.md:1561-1562` documents
   `model/rerouted` (`fromModel`, `toModel`, `reason` — e.g. high-risk cyber safety checks) and
   `model/verification` with a `trustedAccessForCyber` flag. A non-Codex harness talking to the
   ChatGPT backend needs to surface both, or users will silently get a different model.

For a **third-party harness** targeting the direct API, the concrete work is:
- Add `daybreak-blue-latest` as a selectable model ID on `v1/responses` (and `v1/chat/completions`).
- Metadata: 1,050,000 context window, 128,000 max output, text+image input, reasoning-token support.
- Reasoning effort: pass `reasoning.effort` through with the `gpt-5.6-sol` value set; default `medium`.
- Pricing/telemetry: bill at the `gpt-5.6-sol` rate, with the >272K long-context tier.
- Error handling: expect 401/403-class failures for non-provisioned orgs, and Free-tier unsupported.
- Safety posture: default to a reviewed/sandboxed approval mode rather than full access, per
  OpenAI's own Daybreak guidance.
- For ChatGPT Codex authentication, wire `gpt-daybreak-blue-latest` with the remote catalog's
  272,000-token context, text/image input, cyber specialty, low default effort, and
  `low|medium|high|xhigh|max|ultra` effort list.

## Sources

- https://developers.openai.com/api/docs/models/daybreak-blue-latest
- https://developers.openai.com/api/docs/models/daybreak-red-latest
- https://developers.openai.com/api/docs/models/gpt-5.6-sol
- https://developers.openai.com/api/docs/models/all
- https://developers.openai.com/api/docs/changelog
- https://developers.openai.com/api/docs/pricing
- https://developers.openai.com/codex/concepts/cyber-safety
- https://developers.openai.com/codex/agent-approvals-security
- https://openai.com/index/expanding-daybreak-as-the-cyber-defense-window-narrows/
- https://openai.com/index/daybreak-models-are-now-available-on-aws/
- https://openai.com/index/putting-frontier-cyber-models-in-more-trusted-hands/
- https://openai.com/daybreak/
- https://help.openai.com/en/articles/20001258-openai-daybreak-trusted-access-for-cyber-overview
- https://aws.amazon.com/blogs/machine-learning/accelerate-cyber-defense-with-openai-and-aws-daybreak-red-daybreak-blue-now-available-to-eligible-customers-on-amazon-bedrock/
- https://github.com/openai/codex (full clone + full history grep; 0 hits for "daybreak")
- https://community.openai.com/t/gpt-daybreak-blue-latest-in-codex/1389968 — **unverified /
  secondary, user-generated; not confirmed by OpenAI directly**
