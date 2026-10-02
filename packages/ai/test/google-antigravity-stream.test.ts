import { describe, expect, it, vi } from "vitest";
import { stream, streamSimple } from "../src/api/google-antigravity.ts";
import { buildAntigravityModels, PROJECT_ID_HEADER } from "../src/api/google-antigravity-shared.ts";
import { clampMaxTokensToContext } from "../src/api/simple-options.ts";
import type { FetchFunction, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model = buildAntigravityModels("google-antigravity")[0];
const context = normalizeContext({
	systemPrompt: "Be brief",
	messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
	tools: [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }],
});
const auth = { apiKey: "fake-access", headers: { [PROJECT_ID_HEADER]: "fake-project" } };
const hello = { response: { candidates: [{ content: { parts: [{ text: "Hello" }] }, finishReason: "STOP" }] } };

type Envelope = {
	project: string;
	model: string;
	userAgent: string;
	requestType: string;
	request: {
		systemInstruction: { role: string };
		contents: unknown[];
		labels: Record<string, string>;
		toolConfig: { functionCallingConfig: { mode: string } };
		generationConfig?: {
			maxOutputTokens: number;
			thinkingConfig?: { includeThoughts: boolean; thinkingBudget: number; thinkingLevel?: string };
		};
	};
};

function response(frames: readonly unknown[], chunkSize = 7, finalNewline = true): Response {
	const data = new TextEncoder().encode(
		frames.map((frame) => `data: ${JSON.stringify(frame)}`).join("\r\n\r\n") + (finalNewline ? "\r\n\r\n" : ""),
	);
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (let offset = 0; offset < data.length; offset += chunkSize) {
					controller.enqueue(data.slice(offset, offset + chunkSize));
				}
				controller.close();
			},
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

describe("Google Antigravity stream", () => {
	it("sends the Cloud Code envelope with subscription auth and observes unwrapped chunks", async () => {
		let url: string | undefined;
		let headers: Headers | undefined;
		let body: Envelope | undefined;
		const observer = vi.fn();
		const fetch: FetchFunction = async (input, init) => {
			url = String(input);
			headers = new Headers(init?.headers);
			body = JSON.parse(String(init?.body)) as Envelope;
			return response([hello]);
		};
		const result = await stream(model, context, {
			...auth,
			fetch,
			headers: { ...auth.headers, "x-goog-api-key": "wrong-auth", authorization: "wrong-token" },
			onProviderStreamEvent: observer,
		}).result();
		expect(url).toBe(`${model.baseUrl}/v1internal:streamGenerateContent?alt=sse`);
		expect(headers?.get("authorization")).toBe("Bearer fake-access");
		expect(headers?.get(PROJECT_ID_HEADER)).toBeNull();
		expect(headers?.get("x-goog-api-key")).toBeNull();
		expect(headers?.get("user-agent")).toContain("antigravity/cli/");
		expect(body).toMatchObject({
			project: "fake-project",
			model: model.id,
			userAgent: "antigravity",
			requestType: "agent",
			request: {
				systemInstruction: { role: "user" },
				labels: { used_non_gemini_model: "false" },
				toolConfig: { functionCallingConfig: { mode: "VALIDATED" } },
			},
		});
		expect(result.content).toEqual([{ type: "text", text: "Hello", textSignature: undefined }]);
		expect(result.stopReason).toBe("stop");
		expect(observer).toHaveBeenCalledWith(hello.response, model);
	});

	it("retains UTF-8, signatures, no-argument calls, duplicate call IDs, usage, and a final unterminated frame", async () => {
		const frames = [
			{
				response: {
					responseId: "response-1",
					candidates: [
						{
							content: {
								parts: [
									{ text: "考え", thought: true, thoughtSignature: "thought-signature" },
									{ text: "答え", thoughtSignature: "text-signature" },
									{ functionCall: { name: "read", id: "same" }, thoughtSignature: "call-signature" },
									{ functionCall: { name: "read", id: "same", args: { path: "README.md" } } },
								],
							},
							finishReason: "STOP",
						},
					],
					usageMetadata: {
						promptTokenCount: 30,
						cachedContentTokenCount: 10,
						candidatesTokenCount: 4,
						thoughtsTokenCount: 6,
						totalTokenCount: 40,
					},
				},
			},
		];
		const result = await stream(model, context, { ...auth, fetch: async () => response(frames, 1, false) }).result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.responseId).toBe("response-1");
		expect(result.content[0]).toEqual({ type: "thinking", thinking: "考え", thinkingSignature: "thought-signature" });
		expect(result.content[1]).toEqual({ type: "text", text: "答え", textSignature: "text-signature" });
		expect(result.content[2]).toMatchObject({
			type: "toolCall",
			id: "same",
			arguments: {},
			thoughtSignature: "call-signature",
		});
		expect(result.content[3]).toMatchObject({ type: "toolCall", arguments: { path: "README.md" } });
		expect(result.content[3]).not.toMatchObject({ id: "same" });
		expect(result.usage).toMatchObject({ input: 20, output: 10, cacheRead: 10, reasoning: 6, totalTokens: 40 });
	});

	it("replays opaque function signatures into the next Gemini request", async () => {
		const first = await stream(model, context, {
			...auth,
			fetch: async () =>
				response([
					{
						response: {
							candidates: [
								{
									content: {
										parts: [
											{ functionCall: { name: "read", id: "call", args: {} }, thoughtSignature: "c2ln" },
										],
									},
									finishReason: "STOP",
								},
							],
						},
					},
				]),
		}).result();
		let sent: Envelope | undefined;
		await stream(
			model,
			normalizeContext({
				messages: [
					{ role: "user", content: "read", timestamp: 1 },
					first,
					{
						role: "toolResult",
						toolCallId: "call",
						toolName: "read",
						content: [{ type: "text", text: "done" }],
						isError: false,
						timestamp: 2,
					},
				],
			}),
			{
				...auth,
				fetch: async (_input, init) => {
					sent = JSON.parse(String(init?.body)) as Envelope;
					return response([hello]);
				},
			},
		).result();
		expect(sent?.request.contents).toContainEqual({
			role: "model",
			parts: [{ functionCall: { name: "read", id: "call", args: {} }, thoughtSignature: "c2ln" }],
		});
	});

	it("retains a signature delivered after its text block", async () => {
		const result = await stream(model, context, {
			...auth,
			fetch: async () =>
				response([
					{ response: { candidates: [{ content: { parts: [{ text: "thought", thought: true }] } }] } },
					{
						response: {
							candidates: [
								{ content: { parts: [{ thoughtSignature: "signature-after-text" }] }, finishReason: "STOP" },
							],
						},
					},
				]),
		}).result();
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "thought", thinkingSignature: "signature-after-text" },
		]);
	});

	it.each(["none", "any", "auto"] as const)("preserves explicit tool selection %s", async (toolChoice) => {
		let sent: Envelope | undefined;
		await stream(model, context, {
			...auth,
			toolChoice,
			fetch: async (_input, init) => {
				sent = JSON.parse(String(init?.body)) as Envelope;
				return response([hello]);
			},
		}).result();
		expect(sent?.request.toolConfig.functionCallingConfig.mode).toBe(toolChoice.toUpperCase());
	});

	it("keeps simple thinking and answer within model and remaining context limits", async () => {
		const constrained: Model<"google-antigravity"> = { ...model, contextWindow: 6000, maxTokens: 32768 };
		let sent: Envelope | undefined;
		await streamSimple(constrained, context, {
			...auth,
			maxTokens: 30000,
			reasoning: "high",
			toolChoice: "none",
			fetch: async (_input, init) => {
				sent = JSON.parse(String(init?.body)) as Envelope;
				return response([hello]);
			},
		}).result();
		const config = sent?.request.generationConfig;
		expect(config?.maxOutputTokens).toBe(clampMaxTokensToContext(constrained, context, 32768));
		expect(config?.thinkingConfig?.thinkingBudget).toBeLessThanOrEqual((config?.maxOutputTokens ?? 0) - 1024);
		expect(config?.thinkingConfig).not.toHaveProperty("thinkingLevel");
		expect(sent?.request.toolConfig.functionCallingConfig.mode).toBe("NONE");
	});

	it("omits thinking when off and caps the caller's oversized nonthinking request", async () => {
		let sent: Envelope | undefined;
		await streamSimple(model, context, {
			...auth,
			maxTokens: model.maxTokens * 2,
			fetch: async (_input, init) => {
				sent = JSON.parse(String(init?.body)) as Envelope;
				return response([hello]);
			},
		}).result();
		expect(sent?.request.generationConfig?.maxOutputTokens).toBe(model.maxTokens);
		expect(sent?.request.generationConfig?.thinkingConfig).toBeUndefined();
	});

	it("uses the injected fetch for project discovery too", async () => {
		const endpoints: string[] = [];
		const result = await stream(model, context, {
			apiKey: "fake-access",
			fetch: async (input) => {
				endpoints.push(String(input));
				return endpoints.length === 1
					? Response.json({ cloudaicompanionProject: "fake-project" })
					: response([hello]);
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(endpoints[0]).toContain("loadCodeAssist");
		expect(endpoints[1]).toContain("streamGenerateContent");
	});

	it("cancels a pending reader and preserves partial text on abort", async () => {
		const abort = new AbortController();
		const cancelled = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(hello)}\n\n`));
			},
			cancel: cancelled,
		});
		const events = stream(model, context, { ...auth, signal: abort.signal, fetch: async () => new Response(body) });
		for await (const event of events) {
			if (event.type === "text_delta") abort.abort();
		}
		const result = await events.result();
		expect(result.stopReason).toBe("aborted");
		expect(result.content[0]).toMatchObject({ text: "Hello" });
		expect(cancelled).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
	});

	it("times out a stalled stream and releases its reader", async () => {
		const cancelled = vi.fn();
		const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
		const result = await stream(model, context, {
			...auth,
			timeoutMs: 15,
			fetch: async () => new Response(body),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/timeout|timed out/i);
		expect(cancelled).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
	});

	it("reports malformed SSE and HTTP quota details", async () => {
		const malformed = await stream(model, context, {
			...auth,
			fetch: async () => new Response("data: {bad}\n\n"),
		}).result();
		expect(malformed.stopReason).toBe("error");
		const quota = await stream(model, context, {
			...auth,
			fetch: async () =>
				Response.json({ error: { message: "Resets in 31m35s.", status: "RESOURCE_EXHAUSTED" } }, { status: 429 }),
		}).result();
		expect(quota.errorMessage).toContain("429");
		expect(quota.errorMessage).toContain("Resets in 31m35s. (RESOURCE_EXHAUSTED)");
	});

	it("does not convert a rejected finish reason to tool success", async () => {
		const result = await stream(model, context, {
			...auth,
			fetch: async () =>
				response([
					{
						response: {
							candidates: [{ content: { parts: [{ functionCall: { name: "read" } }] }, finishReason: "SAFETY" }],
						},
					},
				]),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("SAFETY");
	});

	it("reports an error frame instead of completing an empty successful response", async () => {
		const result = await stream(model, context, {
			...auth,
			fetch: async () => response([{ error: { message: "Stream quota exhausted", status: "RESOURCE_EXHAUSTED" } }]),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Stream quota exhausted (RESOURCE_EXHAUSTED)");
	});

	it("rejects missing OAuth, non-Google models, and pre-aborted requests without network", async () => {
		const fetch = vi.fn<FetchFunction>();
		expect((await stream(model, context, { fetch }).result()).errorMessage).toContain("OAuth");
		expect(
			(await stream({ ...model, id: "claude-example" }, context, { ...auth, fetch }).result()).errorMessage,
		).toContain("Gemini");
		expect((await stream(model, context, { ...auth, fetch, signal: AbortSignal.abort() }).result()).stopReason).toBe(
			"aborted",
		);
		expect(fetch).not.toHaveBeenCalled();
	});
});
