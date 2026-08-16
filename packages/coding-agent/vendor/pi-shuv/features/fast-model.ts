import type { ExtensionAPI } from "@shuv1337/shuvpi-coding-agent";

/**
 * Dedicated always-fast model alias.
 *
 * models.json defines a custom `gpt-5.5-fast` model under the `openai-codex`
 * provider. That id is not a real wire model, so this hook rewrites the
 * provider payload right before the request goes out:
 *   - model: "gpt-5.5-fast" -> "gpt-5.5"
 *   - service_tier: "priority" (OpenAI priority processing, i.e. fast mode)
 *
 * This mirrors what pi's built-in /fast toggle does (core/fast-mode.ts),
 * but permanently, via a selectable model id.
 */
const FAST_MODEL_ALIAS = "gpt-5.5-fast";
const FAST_MODEL_WIRE_ID = "gpt-5.5";

export function registerFastModel(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event) => {
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return;
    }
    const record = payload as Record<string, unknown>;
    if (record.model !== FAST_MODEL_ALIAS) {
      return;
    }
    return {
      ...record,
      model: FAST_MODEL_WIRE_ID,
      service_tier: "priority",
    };
  });
}
