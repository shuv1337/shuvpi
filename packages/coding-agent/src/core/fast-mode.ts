import type { Api, Model } from "@shuv1337/shuvpi-ai";

const FAST_MODE_ELIGIBLE_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.5",
	"gpt-5.6",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
]);
const FAST_MODE_ELIGIBLE_APIS = new Set(["openai-responses", "openai-codex-responses"]);
const FAST_MODE_ELIGIBLE_PROVIDERS = new Set(["openai", "openai-codex"]);

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function supportsFastMode(model: Model<Api> | undefined): boolean {
	return !!(
		model &&
		FAST_MODE_ELIGIBLE_PROVIDERS.has(model.provider) &&
		FAST_MODE_ELIGIBLE_APIS.has(model.api) &&
		FAST_MODE_ELIGIBLE_MODEL_IDS.has(model.id)
	);
}

export function applyFastModeToPayload(payload: unknown, model: Model<Api> | undefined, enabled: boolean): unknown {
	if (!enabled || !supportsFastMode(model) || !isObjectRecord(payload)) {
		return payload;
	}

	return {
		...payload,
		service_tier: "priority",
	};
}
