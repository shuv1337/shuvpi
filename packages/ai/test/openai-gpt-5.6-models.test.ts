import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/compat.ts";

const GPT_56_MODELS = [
	["gpt-5.6", "GPT-5.6", 5, 30, 0.5, 6.25],
	["gpt-5.6-luna", "GPT-5.6 Luna", 1, 6, 0.1, 1.25],
	["gpt-5.6-sol", "GPT-5.6 Sol", 5, 30, 0.5, 6.25],
	["gpt-5.6-terra", "GPT-5.6 Terra", 2.5, 15, 0.25, 3.125],
] as const;
const GPT_56_CODEX_MODELS = [GPT_56_MODELS[1], GPT_56_MODELS[2], GPT_56_MODELS[3]] as const;

describe("OpenAI GPT-5.6 models", () => {
	it.each(GPT_56_MODELS)(
		"registers %s with current OpenAI metadata",
		(modelId, name, inputCost, outputCost, cacheReadCost, cacheWriteCost) => {
			const model = getModel("openai", modelId);

			expect(model).toBeDefined();
			expect(model).toMatchObject({
				id: modelId,
				name,
				api: "openai-responses",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				reasoning: true,
				input: ["text", "image"],
				cost: {
					input: inputCost,
					output: outputCost,
					cacheRead: cacheReadCost,
					cacheWrite: cacheWriteCost,
				},
				contextWindow: 1_050_000,
				maxTokens: 128_000,
				thinkingLevelMap: { off: "none", minimal: null, xhigh: "xhigh" },
			});
			expect(getSupportedThinkingLevels(model!)).toEqual(["off", "low", "medium", "high", "xhigh"]);
		},
	);

	it.each(GPT_56_CODEX_MODELS)(
		"registers %s for Codex OAuth",
		(modelId, name, inputCost, outputCost, cacheReadCost) => {
			const model = getModel("openai-codex", modelId);

			expect(model).toBeDefined();
			expect(model).toMatchObject({
				id: modelId,
				name,
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: "https://chatgpt.com/backend-api",
				reasoning: true,
				input: ["text", "image"],
				cost: {
					input: inputCost,
					output: outputCost,
					cacheRead: cacheReadCost,
					cacheWrite: 0,
				},
				contextWindow: 272_000,
				maxTokens: 128_000,
				thinkingLevelMap: { minimal: "low", xhigh: "xhigh" },
			});
			expect(getSupportedThinkingLevels(model!)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
		},
	);
});
