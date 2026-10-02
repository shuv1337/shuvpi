import { beforeAll, describe, expect, it, vi } from "vitest";
import { getEffortThinkingLevelMap } from "../scripts/models-dev-reasoning-options.ts";
import { streamSimple as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { streamSimple as streamAzure } from "../src/api/azure-openai-responses.ts";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { resolveGoogleThinkingLevel } from "../src/api/google-shared.ts";
import { streamSimple as streamCodex } from "../src/api/openai-codex-responses.ts";
import { streamSimple as streamCompletions } from "../src/api/openai-completions.ts";
import { streamSimple as streamOpenAI } from "../src/api/openai-responses.ts";
import { thinkingBudgetForLevel } from "../src/api/simple-options.ts";
import { clampThinkingLevel, createModels, getSupportedThinkingLevels } from "../src/models.ts";
import { AZURE_OPENAI_RESPONSES_MODELS } from "../src/providers/azure-openai-responses.models.ts";
import { openaiProvider } from "../src/providers/openai.ts";
import { openaiCodexProvider } from "../src/providers/openai-codex.ts";
import type { Api, Model, SimpleStreamOptions } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { generateModelCatalog, type MetadataRequest } from "./model-generation-support.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "test", timestamp: 0 }] });
let openai: Model<"openai-responses">;
let codex: Model<"openai-codex-responses">;
let azureModels: Record<string, Model<Api>>;
let metadataRequests: MetadataRequest[];

beforeAll(() => {
	const { providers, requests } = generateModelCatalog({
		openai: {
			models: {
				"gpt-daybreak-blue-latest": {
					id: "gpt-daybreak-blue-latest",
					name: "Upstream Daybreak Blue",
					tool_call: true,
					reasoning: true,
					modalities: { input: ["text", "image"] },
					limit: { context: 272000, output: 128000 },
				},
			},
		},
	});
	metadataRequests = requests;
	openai = providers.openai["daybreak-blue-latest"] as Model<"openai-responses">;
	codex = providers["openai-codex"]["gpt-daybreak-blue-latest"] as Model<"openai-codex-responses">;
	azureModels = providers["azure-openai-responses"];
});

describe("Daybreak generation and advertised ultra effort", () => {
	it("ships the selected rows through the actual package provider catalogs and runtime model lookup", () => {
		const models = createModels();
		models.setProvider(openaiProvider());
		models.setProvider(openaiCodexProvider());
		const shippedOpenai = models.getModel("openai", "daybreak-blue-latest");
		const shippedCodex = models.getModel("openai-codex", "gpt-daybreak-blue-latest");
		expect(shippedOpenai).toEqual(openai);
		expect(shippedCodex).toEqual(codex);
		expect(getSupportedThinkingLevels(shippedCodex!)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
		expect(Object.keys(AZURE_OPENAI_RESPONSES_MODELS).some((id) => id.includes("daybreak-blue"))).toBe(false);
	});

	it("generates metadata using only unauthenticated catalog reads", () => {
		expect(metadataRequests.map(({ url }) => url).sort()).toEqual(
			[
				"https://models.dev/api.json",
				"https://models.dev/models.json?type=decision",
				"https://openrouter.ai/api/v1/models",
				"https://openrouter.ai/api/v1/models?output_modalities=image",
				"https://openrouter.ai/api/v1/models?output_modalities=decisions",
				"https://ai-gateway.vercel.sh/v1/models",
				"https://radius.pi.dev/v1/config",
			].sort(),
		);
		expect(metadataRequests.every(({ method, hasAuthorization }) => method === "GET" && !hasAuthorization)).toBe(
			true,
		);
	});

	it("generates the selected provider routes and capabilities without an Azure clone", () => {
		expect(openai).toMatchObject({
			id: "daybreak-blue-latest",
			provider: "openai",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 272000,
			maxTokens: 128000,
			compat: { supportsOpenAIGrammarTools: true },
		});
		expect(codex).toMatchObject({
			id: "gpt-daybreak-blue-latest",
			provider: "openai-codex",
			api: "openai-codex-responses",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 272000,
			maxTokens: 128000,
			compat: { supportsOpenAIGrammarTools: true },
		});
		expect(openai.compat?.supportsToolSearch).toBe(true);
		expect(codex.compat?.supportsToolSearch).toBe(true);
		expect(Object.keys(azureModels).some((id) => id.includes("daybreak"))).toBe(false);
		expect(getSupportedThinkingLevels(openai)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
		expect(getSupportedThinkingLevels(codex)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
	});

	it.each(["ultra", "max"] as const)(
		"sends native Codex %s and clamps unsupported OpenAI ultra to max",
		async (reasoning) => {
			const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("unexpected network dispatch"));
			const payloads: unknown[] = [];
			const options: SimpleStreamOptions = {
				apiKey: "fake-token",
				headers: { "chatgpt-account-id": "fake-account" },
				reasoning,
				fetch,
				onPayload: (payload) => {
					payloads.push(payload);
					throw new Error("captured before network");
				},
			};
			await streamCodex(codex, context, options).result();
			await streamOpenAI(openai, context, options).result();
			expect(payloads).toHaveLength(2);
			expect(payloads[0]).toMatchObject({ model: "gpt-daybreak-blue-latest", reasoning: { effort: reasoning } });
			expect(payloads[1]).toMatchObject({ model: "daybreak-blue-latest", reasoning: { effort: "max" } });
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it("keeps ultra opt-in for metadata and custom provider mappings", () => {
		const standard = { ...openai, thinkingLevelMap: undefined };
		expect(getSupportedThinkingLevels(standard)).not.toContain("ultra");
		expect(clampThinkingLevel(standard, "ultra")).toBe("high");
		expect(
			getSupportedThinkingLevels({ ...standard, reasoning: false, thinkingLevelMap: { ultra: "ultra" } }),
		).toEqual(["off"]);
		expect(getSupportedThinkingLevels({ ...standard, thinkingLevelMap: { ultra: null } })).not.toContain("ultra");
		expect(getEffortThinkingLevelMap([{ type: "effort", values: ["high", "ultra"] }])).toMatchObject({
			high: "high",
			ultra: "ultra",
			off: null,
		});
		expect(getEffortThinkingLevelMap([{ type: "effort", values: ["high", "max"] }])).not.toHaveProperty("ultra");
	});

	it("maps opt-in ultra through Azure and Chat Completions and clamps unadvertised effort", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("unexpected network dispatch"));
		const payloads: unknown[] = [];
		const options: SimpleStreamOptions = {
			apiKey: "fake-key",
			reasoning: "ultra",
			fetch,
			onPayload: (payload) => {
				payloads.push(payload);
				throw new Error("captured before network");
			},
		};
		const azure: Model<"azure-openai-responses"> = {
			...openai,
			api: "azure-openai-responses",
			provider: "azure-openai-responses",
			baseUrl: "https://example.openai.azure.com/openai/v1",
			thinkingLevelMap: { ultra: "ultra" },
		};
		const completions: Model<"openai-completions"> = {
			...openai,
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://example.invalid/v1",
			compat: { supportsReasoningEffort: true },
			thinkingLevelMap: { ultra: "native-ultra" },
		};
		await streamAzure(azure, context, options).result();
		await streamCompletions(completions, context, options).result();
		await streamCompletions({ ...completions, thinkingLevelMap: undefined }, context, options).result();
		expect(payloads).toHaveLength(3);
		expect(payloads[0]).toMatchObject({ reasoning: { effort: "ultra" } });
		expect(payloads[1]).toMatchObject({ reasoning_effort: "native-ultra" });
		expect(payloads[2]).toMatchObject({ reasoning_effort: "high" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("maps Bedrock ultra to supported adaptive effort and bounded token budgets", async () => {
		const payloads: unknown[] = [];
		const base: Model<"bedrock-converse-stream"> = {
			...openai,
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			id: "anthropic.claude-opus-5",
			compat: undefined,
			thinkingLevelMap: undefined,
		};
		for (const model of [base, { ...base, id: "anthropic.claude-sonnet-4-5", name: "Claude Sonnet 4.5" }]) {
			await streamBedrock(model, context, {
				reasoning: "ultra",
				thinkingBudgets: { high: 4096 },
				region: "us-east-1",
				env: { AWS_ACCESS_KEY_ID: "fake-access", AWS_SECRET_ACCESS_KEY: "fake-secret" },
				onPayload: (payload) => {
					payloads.push(payload);
					throw new Error("captured before network");
				},
			}).result();
		}
		expect(payloads).toHaveLength(2);
		expect(payloads[0]).toMatchObject({
			additionalModelRequestFields: { thinking: { type: "adaptive" }, output_config: { effort: "high" } },
		});
		expect(payloads[1]).toMatchObject({
			additionalModelRequestFields: { thinking: { type: "enabled", budget_tokens: 4096 } },
		});
	});

	it("uses safe provider fallbacks and honors an explicitly advertised mapping", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("unexpected network dispatch"));
		const payloads: unknown[] = [];
		const anthropic: Model<"anthropic-messages"> = {
			...openai,
			id: "claude-test",
			provider: "anthropic",
			api: "anthropic-messages",
			baseUrl: "https://example.invalid",
			compat: { forceAdaptiveThinking: true },
			thinkingLevelMap: undefined,
		};
		const options: SimpleStreamOptions = {
			apiKey: "fake-key",
			reasoning: "ultra",
			fetch,
			onPayload: (payload) => {
				payloads.push(payload);
				throw new Error("captured before network");
			},
		};
		await streamAnthropic(anthropic, context, options).result();
		await streamAnthropic({ ...anthropic, thinkingLevelMap: { ultra: "max" } }, context, options).result();
		expect(payloads[0]).toMatchObject({ output_config: { effort: "high" } });
		expect(payloads[1]).toMatchObject({ output_config: { effort: "max" } });
		expect(thinkingBudgetForLevel("ultra", { high: 4096 })).toBe(4096);
		const google: Model<"google-generative-ai"> = {
			...openai,
			api: "google-generative-ai",
			provider: "google",
			compat: undefined,
			thinkingLevelMap: { ultra: "high" },
		};
		expect(resolveGoogleThinkingLevel(google, "ultra")).toBe("high");
		expect(fetch).not.toHaveBeenCalled();
	});
});
