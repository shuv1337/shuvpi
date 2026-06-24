import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.ts";
import { convertMessages, getCompat } from "../src/providers/openai-completions.ts";
import { stream, streamSimple } from "../src/stream.ts";
import type { ChatTemplateValue, Model, Tool } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
	chunks: undefined as
		| Array<{
				id?: string;
				choices?: Array<{ delta: Record<string, unknown>; finish_reason: string | null }>;
		  }>
		| undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							const chunks = mockState.chunks ?? [
								{
									choices: [{ delta: {}, finish_reason: "stop" }],
								},
							];
							for (const chunk of chunks) {
								yield chunk;
							}
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

async function capturePayload(
	model: Model<"openai-completions">,
	options?: {
		reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh";
		maxTokens?: number;
		tools?: Tool[];
		systemPrompt?: string;
	},
): Promise<Record<string, unknown>> {
	let payload: unknown;

	await streamSimple(
		model,
		{
			systemPrompt: options?.systemPrompt,
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			tools: options?.tools,
		},
		{
			apiKey: "test",
			maxTokens: options?.maxTokens,
			reasoning: options?.reasoning,
			onPayload: (params: unknown) => {
				payload = params;
			},
		},
	).result();

	return (payload ?? mockState.lastParams) as Record<string, unknown>;
}

describe("openai-completions chat-template args", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.chunks = undefined;
	});

	it("emits chat_template_args.enable_thinking when opt-in reasoning is enabled", async () => {
		const model = getModel("baseten", "moonshotai/Kimi-K2.6") as Model<"openai-completions">;
		const params = await capturePayload(model, { reasoning: "high" });

		expect(params.chat_template_args).toEqual({ enable_thinking: true });
		expect(params).not.toHaveProperty("chat_template_kwargs");
	});

	it.each(["minimal", "low", "medium"] as const)(
		"clamps unsupported opt-in Baseten thinking level %s to high and enables thinking",
		async (reasoning) => {
			const model = getModel("baseten", "moonshotai/Kimi-K2.6") as Model<"openai-completions">;
			const params = await capturePayload(model, { reasoning });

			expect(params.chat_template_args).toEqual({ enable_thinking: true });
		},
	);

	it("emits chat_template_args.enable_thinking false when reasoning is disabled", async () => {
		const model = getModel("baseten", "moonshotai/Kimi-K2.6") as Model<"openai-completions">;
		const params = await capturePayload(model);

		expect(params.chat_template_args).toEqual({ enable_thinking: false });
		expect(params).not.toHaveProperty("chat_template_kwargs");
	});

	it("sends reasoning_effort for always-on Baseten models without chat-template fields", async () => {
		const model = getModel("baseten", "deepseek-ai/DeepSeek-V4-Pro") as Model<"openai-completions">;
		const params = await capturePayload(model, { reasoning: "high" });

		expect(params.reasoning_effort).toBe("high");
		expect(params).not.toHaveProperty("chat_template_args");
		expect(params).not.toHaveProperty("chat_template_kwargs");
	});

	it("does not invent an off reasoning_effort for always-on Baseten models", async () => {
		const model = getModel("baseten", "deepseek-ai/DeepSeek-V4-Pro") as Model<"openai-completions">;
		const params = await capturePayload(model);

		expect(params).not.toHaveProperty("reasoning_effort");
	});

	it("clamps unsupported xhigh reasoning_effort to high for GPT OSS 120B", async () => {
		const model = getModel("baseten", "openai/gpt-oss-120b") as Model<"openai-completions">;
		const params = await capturePayload(model, { reasoning: "xhigh" });

		expect(params.reasoning_effort).toBe("high");
		expect(params).not.toHaveProperty("chat_template_args");
	});

	it("uses max_tokens and suppresses unsupported OpenAI extras for Baseten", async () => {
		const model = getModel("baseten", "moonshotai/Kimi-K2.6") as Model<"openai-completions">;
		const tools: Tool[] = [
			{
				name: "ping",
				description: "Ping tool",
				parameters: Type.Object({ ok: Type.Boolean() }),
			},
		];
		const params = await capturePayload(model, { maxTokens: 128, tools });

		expect(params.max_tokens).toBe(128);
		expect(params).not.toHaveProperty("max_completion_tokens");
		expect(params).not.toHaveProperty("store");
		expect(params.prompt_cache_retention).toBeUndefined();
		const tool = (params.tools as Array<{ function?: { strict?: boolean } }>)[0];
		expect(tool.function?.strict).toBeUndefined();
	});

	it("uses system role instead of developer for Baseten reasoning models", async () => {
		const model = getModel("baseten", "moonshotai/Kimi-K2.6") as Model<"openai-completions">;
		const params = await capturePayload(model, {
			reasoning: "high",
			systemPrompt: "You are helpful.",
		});

		const messages = params.messages as Array<{ role: string; content: string }>;
		expect(messages[0]).toEqual({ role: "system", content: "You are helpful." });
	});

	it("auto-detects conservative Baseten compat for custom models.json entries", async () => {
		const model: Model<"openai-completions"> = {
			id: "moonshotai/Kimi-K2.6",
			name: "Kimi K2.6",
			api: "openai-completions",
			provider: "baseten",
			baseUrl: "https://inference.baseten.co/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262000,
			maxTokens: 262000,
		};
		const params = await capturePayload(model, { maxTokens: 64 });

		expect(params.max_tokens).toBe(64);
		expect(params).not.toHaveProperty("max_completion_tokens");
		expect(params).not.toHaveProperty("store");
	});

	it("emits generic chat_template_kwargs when configured", async () => {
		const model: Model<"openai-completions"> = {
			id: "chat-template-kwargs",
			name: "Chat Template Kwargs",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "http://localhost:8000/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 4096,
			compat: {
				thinkingFormat: "chat-template",
				chatTemplateKwargs: {
					enable_thinking: { $var: "thinking.enabled" },
				},
			},
		};
		const params = await capturePayload(model, { reasoning: "high" });

		expect(params.chat_template_kwargs).toEqual({ enable_thinking: true });
		expect(params).not.toHaveProperty("chat_template_args");
	});

	it("omits thinking.effort fields with omitWhenOff when reasoning is disabled", async () => {
		const model: Model<"openai-completions"> = {
			id: "chat-template-effort",
			name: "Chat Template Effort",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "http://localhost:8000/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 4096,
			thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high" },
			compat: {
				thinkingFormat: "chat-template",
				chatTemplateArgs: {
					reasoning_level: { $var: "thinking.effort", omitWhenOff: true },
				},
			},
		};
		const params = await capturePayload(model);

		expect(params.chat_template_args).toBeUndefined();
	});

	it("omits thinking.effort keys mapped to null from chat_template_args", async () => {
		const model: Model<"openai-completions"> = {
			id: "chat-template-effort-null",
			name: "Chat Template Effort Null",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "http://localhost:8000/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 4096,
			thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null },
			compat: {
				thinkingFormat: "chat-template",
				chatTemplateArgs: {
					reasoning_level: { $var: "thinking.effort", omitWhenOff: true },
				},
			},
		};
		let payload: unknown;

		await stream(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
			{
				apiKey: "test",
				reasoningEffort: "high",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as Record<string, unknown>;
		expect(params.chat_template_args).toBeUndefined();
	});

	it("resolves thinking.effort variables into chat_template_args", async () => {
		const model: Model<"openai-completions"> = {
			id: "chat-template-effort-enabled",
			name: "Chat Template Effort Enabled",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "http://localhost:8000/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 4096,
			thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high" },
			compat: {
				thinkingFormat: "chat-template",
				chatTemplateArgs: {
					reasoning_level: { $var: "thinking.effort", omitWhenOff: true },
				},
			},
		};
		const params = await capturePayload(model, { reasoning: "medium" });

		expect(params.chat_template_args).toEqual({ reasoning_level: "medium" });
	});

	it("emits both chat_template_kwargs and chat_template_args when configured", async () => {
		const model: Model<"openai-completions"> = {
			id: "chat-template-both",
			name: "Chat Template Both",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "http://localhost:8000/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 4096,
			compat: {
				thinkingFormat: "chat-template",
				chatTemplateKwargs: {
					enable_thinking: { $var: "thinking.enabled" },
				},
				chatTemplateArgs: {
					preserve_thinking: true,
				},
			},
		};
		const params = await capturePayload(model, { reasoning: "high" });

		expect(params.chat_template_kwargs).toEqual({ enable_thinking: true });
		expect(params.chat_template_args).toEqual({ preserve_thinking: true });
	});

	it("throws on unrecognized chat-template variables at payload build time", async () => {
		const model: Model<"openai-completions"> = {
			id: "chat-template-invalid-var",
			name: "Chat Template Invalid Var",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "http://localhost:8000/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 4096,
			compat: {
				thinkingFormat: "chat-template",
				chatTemplateArgs: {
					enable_thinking: { $var: "thinking.depth" } as unknown as ChatTemplateValue,
				},
			},
		};

		const result = await stream(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
			{ apiKey: "test", reasoningEffort: "high" },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Unrecognized chat-template variable: thinking.depth");
	});

	it("preserves existing qwen-chat-template behavior", async () => {
		const model: Model<"openai-completions"> = {
			id: "qwen-test",
			name: "Qwen Test",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "http://localhost:8000/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 4096,
			compat: { thinkingFormat: "qwen-chat-template" },
		};
		const params = await capturePayload(model, { reasoning: "high" });

		expect(params.chat_template_kwargs).toEqual({
			enable_thinking: true,
			preserve_thinking: true,
		});
		expect(params).not.toHaveProperty("chat_template_args");
	});

	it("replays Baseten assistant tool calls with empty reasoning_content when thinking is missing", () => {
		const model = getModel("baseten", "moonshotai/Kimi-K2.6") as Model<"openai-completions">;
		const messages = convertMessages(
			model,
			{
				messages: [
					{
						role: "assistant",
						api: "openai-completions",
						provider: "baseten",
						model: "moonshotai/Kimi-K2.6",
						content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } }],
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					},
				],
			},
			getCompat(model),
		);

		expect(messages[0]).toMatchObject({ role: "assistant", reasoning_content: "" });
	});

	it("replays Baseten DeepSeek V4 assistant tool calls with empty reasoning_content when thinking is missing", () => {
		const model = getModel("baseten", "deepseek-ai/DeepSeek-V4-Pro") as Model<"openai-completions">;
		const messages = convertMessages(
			model,
			{
				messages: [
					{
						role: "assistant",
						api: "openai-completions",
						provider: "baseten",
						model: "deepseek-ai/DeepSeek-V4-Pro",
						content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } }],
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					},
				],
			},
			getCompat(model),
		);

		expect(messages[0]).toMatchObject({ role: "assistant", reasoning_content: "" });
	});

	it("parses streamed reasoning_content into thinking blocks", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-baseten-reasoning",
				choices: [
					{
						delta: {
							reasoning_content: "thinking step",
							content: "final answer",
						},
						finish_reason: null,
					},
				],
			},
			{
				id: "chatcmpl-baseten-reasoning",
				choices: [{ delta: {}, finish_reason: "stop" }],
			},
		];

		const model = getModel("baseten", "deepseek-ai/DeepSeek-V4-Pro") as Model<"openai-completions">;
		const events: string[] = [];
		const streamResult = stream(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		for await (const event of streamResult) {
			events.push(event.type);
		}

		const response = await streamResult.result();
		const thinking = response.content.find((block) => block.type === "thinking");
		const text = response.content.find((block) => block.type === "text");

		expect(events).toContain("thinking_delta");
		expect(thinking?.type).toBe("thinking");
		if (thinking?.type === "thinking") {
			expect(thinking.thinking).toBe("thinking step");
		}
		expect(text?.type).toBe("text");
		if (text?.type === "text") {
			expect(text.text).toBe("final answer");
		}
	});
});
