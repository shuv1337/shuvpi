import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { getModel, getModels, getProviders } from "../src/models.ts";

const originalBasetenApiKey = process.env.BASETEN_API_KEY;

const BASETEN_BASE_URL = "https://inference.baseten.co/v1";
const BASETEN_REASONING_EFFORT_MODELS = ["deepseek-ai/DeepSeek-V4-Pro", "openai/gpt-oss-120b"] as const;
const BASETEN_CHAT_TEMPLATE_MODELS = [
	"moonshotai/Kimi-K2.5",
	"moonshotai/Kimi-K2.6",
	"moonshotai/Kimi-K2.7-Code",
	"zai-org/GLM-4.7",
	"zai-org/GLM-5",
	"zai-org/GLM-5.1",
	"zai-org/GLM-5.2",
	"nvidia/Nemotron-120B-A12B",
	"nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B",
] as const;

afterEach(() => {
	if (originalBasetenApiKey === undefined) {
		delete process.env.BASETEN_API_KEY;
	} else {
		process.env.BASETEN_API_KEY = originalBasetenApiKey;
	}
});

describe("Baseten models", () => {
	it("registers baseten as a built-in provider", () => {
		expect(getProviders()).toContain("baseten");
	});

	it("generates only tool-capable Baseten models with expected invariants", () => {
		const models = getModels("baseten");
		const reasoningAllowlist = new Set<string>([...BASETEN_REASONING_EFFORT_MODELS, ...BASETEN_CHAT_TEMPLATE_MODELS]);

		expect(models.length).toBeGreaterThan(0);
		for (const model of models) {
			expect(model.provider).toBe("baseten");
			expect(model.api).toBe("openai-completions");
			expect(model.baseUrl).toBe(BASETEN_BASE_URL);

			if (reasoningAllowlist.has(model.id)) {
				expect(model.reasoning).toBe(true);
			} else {
				expect(model.reasoning).toBe(false);
				expect(model.thinkingLevelMap).toBeUndefined();
				expect(model.compat?.thinkingFormat).toBeUndefined();
				expect(model.compat?.chatTemplateArgs).toBeUndefined();
				expect(model.compat?.chatTemplateKwargs).toBeUndefined();
			}
		}

		expect(models.some((model) => model.id === "deepseek-ai/DeepSeek-V3.1")).toBe(false);
		expect(models.some((model) => model.id === "MiniMaxAI/MiniMax-M2.5")).toBe(false);
	});

	it("preserves exact case-sensitive model IDs", () => {
		const kimi = getModel("baseten", "moonshotai/Kimi-K2.6");
		expect(kimi?.id).toBe("moonshotai/Kimi-K2.6");
		expect(getModel("baseten", "moonshotai/kimi-k2.6" as "moonshotai/Kimi-K2.6")).toBeUndefined();
	});

	it("models always-on reasoning controls from Baseten documentation", () => {
		const deepSeekV4 = getModel("baseten", "deepseek-ai/DeepSeek-V4-Pro");
		expect(deepSeekV4?.reasoning).toBe(true);
		expect(deepSeekV4?.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
		});
		expect(deepSeekV4?.compat).toMatchObject({
			supportsReasoningEffort: true,
			thinkingFormat: "openai",
			requiresReasoningContentOnAssistantMessages: true,
		});

		const gptOss = getModel("baseten", "openai/gpt-oss-120b");
		expect(gptOss?.reasoning).toBe(true);
		expect(gptOss?.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
		});
		expect(gptOss?.compat).toMatchObject({
			supportsReasoningEffort: true,
			thinkingFormat: "openai",
		});
	});

	it("models opt-in reasoning families with chat_template_args", () => {
		for (const modelId of BASETEN_CHAT_TEMPLATE_MODELS) {
			const model = getModel("baseten", modelId);
			expect(model?.reasoning).toBe(true);
			expect(model?.thinkingLevelMap).toEqual({
				minimal: null,
				low: null,
				medium: null,
			});
			expect(model?.compat).toMatchObject({
				thinkingFormat: "chat-template",
				requiresReasoningContentOnAssistantMessages: true,
				chatTemplateArgs: {
					enable_thinking: { $var: "thinking.enabled" },
				},
			});
			expect(model?.compat?.chatTemplateKwargs).toBeUndefined();
		}
	});

	it("uses conservative OpenAI compatibility defaults", () => {
		const model = getModel("baseten", "moonshotai/Kimi-K2.6");
		expect(model?.compat).toMatchObject({
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
			supportsLongCacheRetention: false,
		});
	});

	it("preserves vision input metadata from the generated catalog", () => {
		const kimi = getModel("baseten", "moonshotai/Kimi-K2.6");
		expect(kimi?.input).toEqual(["text", "image"]);

		const gptOss = getModel("baseten", "openai/gpt-oss-120b");
		expect(gptOss?.input).toEqual(["text"]);
	});

	it("resolves BASETEN_API_KEY from the environment", () => {
		process.env.BASETEN_API_KEY = "test-baseten-key";

		expect(findEnvKeys("baseten")).toEqual(["BASETEN_API_KEY"]);
		expect(getEnvApiKey("baseten")).toBe("test-baseten-key");
	});
});
