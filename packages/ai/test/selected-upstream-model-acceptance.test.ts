import { beforeAll, describe, expect, it } from "vitest";
import { getModel, getModels, getSupportedThinkingLevels, streamSimple } from "../src/compat.ts";
import type { Api, Model } from "../src/types.ts";
import { generateModelCatalog } from "./model-generation-support.ts";

const fixtureMetadata = {
	name: "Metadata fixture",
	tool_call: true,
	reasoning: true,
	modalities: { input: ["text", "image"] },
	limit: { context: 1_000_000, output: 128_000 },
	cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
};
let generated: Record<string, Record<string, Model<Api>>>;

beforeAll(() => {
	({ providers: generated } = generateModelCatalog({
		"github-copilot": { models: { "claude-opus-5.5": fixtureMetadata } },
		anthropic: {
			models: Object.fromEntries(
				["claude-opus-5", "claude-sonnet-5", "claude-fable-5"].map((id) => [id, fixtureMetadata]),
			),
		},
	}));
});

describe("selected upstream reasoning and catalog acceptance", () => {
	// AI-08: a refresh must repair missing effort metadata, not only a checked-in catalog.
	it("repairs Copilot Opus 5.5 effort metadata and ships the same supported mapping", () => {
		const expected = {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		};
		for (const model of [
			generated["github-copilot"]["claude-opus-5.5"],
			getModel("github-copilot", "claude-opus-5.5"),
		]) {
			expect(model).toMatchObject({ api: "anthropic-messages", reasoning: true, contextWindow: 1_000_000 });
			expect(model.thinkingLevelMap).toEqual(expected);
			expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
		}
	});

	// AI-09: compare incomplete catalog fixtures and the shipped families.
	it.each(["claude-opus-5", "claude-sonnet-5", "claude-fable-5"] as const)(
		"recognizes %s as adaptive reasoning during catalog generation",
		(id) => {
			for (const model of [generated.anthropic[id], getModel("anthropic", id)]) {
				expect(model).toMatchObject({
					id,
					api: "anthropic-messages",
					reasoning: true,
					compat: { forceAdaptiveThinking: true },
				});
				expect(model.thinkingLevelMap).toMatchObject({ xhigh: "xhigh", max: "max" });
				expect(getSupportedThinkingLevels(model)).toEqual(
					id === "claude-sonnet-5"
						? ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
						: ["minimal", "low", "medium", "high", "xhigh", "max"],
				);
			}
		},
	);

	// HIST-03: the selected replacements stay available through public catalog lookup.
	it.each([
		["baseten", "moonshotai/Kimi-K2.6", "openai-completions", 262_000, 262_000],
		["baseten", "zai-org/GLM-5.2", "openai-completions", 1_048_576, 262_144],
		["openai", "gpt-5.5", "openai-responses", 272_000, 128_000],
		["openai", "gpt-5.6-sol", "openai-responses", 272_000, 128_000],
		["openai", "gpt-5.6-terra", "openai-responses", 272_000, 128_000],
		["openai", "gpt-5.6-luna", "openai-responses", 272_000, 128_000],
		["openai-codex", "gpt-5.6-sol", "openai-codex-responses", 272_000, 128_000],
		["xai", "grok-4.6", "openai-responses", 500_000, 500_000],
		["anthropic", "claude-opus-5", "anthropic-messages", 1_000_000, 128_000],
		["anthropic", "claude-sonnet-5", "anthropic-messages", 1_000_000, 128_000],
		["anthropic", "claude-fable-5", "anthropic-messages", 1_000_000, 128_000],
	] as const)(
		"retains %s/%s with its selected transport and token limits",
		(provider, id, api, contextWindow, maxTokens) => {
			const model = getModels(provider).find((candidate) => candidate.id === id);
			if (!model) throw new Error(`Missing selected model ${provider}/${id}`);
			expect(model).toMatchObject({ provider, id, api, contextWindow, maxTokens, reasoning: true });
			expect(model.input).toContain("text");
			expect(model.baseUrl).toMatch(/^https:\/\//);
			expect(getSupportedThinkingLevels(model)).toContain("high");
		},
	);
});

describe("selected DeepSeek request compatibility", () => {
	// AI-10: exercise the real serializer and SDK with a local fake fetch transport.
	it.each([
		["deepseek", "deepseek-flash", "high"],
		["deepseek", "deepseek-flash", undefined],
		["opencode-go", "deepseek-v4-flash", "max"],
		["opencode-go", "deepseek-v4-flash", undefined],
	] as const)("sends the accepted token and reasoning fields for %s/%s (%s)", async (provider, id, reasoning) => {
		const model = getModels(provider).find((candidate) => candidate.id === id);
		if (!model) throw new Error(`Missing selected model ${provider}/${id}`);
		const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const request = input instanceof Request ? input : new Request(input, init);
			requests.push({ url: request.url, body: JSON.parse(await request.text()) });
			const chunks = [
				{ id: "fixture", choices: [{ index: 0, delta: { content: "accepted" }, finish_reason: null }] },
				{
					id: "fixture",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				},
			];
			return new Response(
				`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
				{
					headers: { "content-type": "text/event-stream" },
				},
			);
		};
		const result = await streamSimple(
			model,
			{ messages: [{ role: "user", content: "fixture", timestamp: 0 }] },
			{ apiKey: "local-fixture-key", reasoning, maxTokens: 1234, fetch },
		).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "accepted" }]);
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe(`${model.baseUrl}/chat/completions`);
		expect(requests[0].body).toMatchObject({
			model: id,
			max_tokens: 1234,
			thinking: { type: reasoning ? "enabled" : "disabled" },
		});
		expect(requests[0].body).not.toHaveProperty("max_completion_tokens");
		expect(requests[0].body.reasoning_effort).toBe(reasoning);
	});
});
