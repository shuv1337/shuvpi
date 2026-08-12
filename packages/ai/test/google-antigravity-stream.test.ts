import { afterEach, describe, expect, it, vi } from "vitest";
import {
	stream as streamGoogleAntigravity,
	streamSimple as streamSimpleGoogleAntigravity,
} from "../src/api/google-antigravity.ts";
import type { Context, Model } from "../src/types.ts";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

const model: Model<"google-antigravity"> = {
	id: "gemini-3.7-flash-high",
	name: "Gemini 3.7 Flash (High)",
	api: "google-antigravity",
	provider: "google-antigravity",
	baseUrl: "https://daily-cloudcode-pa.googleapis.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_048_576,
	maxTokens: 65_536,
};

const context: Context = {
	systemPrompt: "be brief",
	messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	tools: [
		{
			name: "read",
			description: "Read a file",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		},
	],
};

function sseResponse(frames: readonly unknown[]): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
			controller.close();
		},
	});
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("google antigravity stream", () => {
	it("posts a Cloud Code envelope and unwraps the SSE response", async () => {
		let requestUrl: string | undefined;
		let requestHeaders: Headers | undefined;
		let requestBody: any;

		global.fetch = vi.fn(async (input: any, init?: RequestInit) => {
			requestUrl = String(input);
			requestHeaders = new Headers(init?.headers);
			requestBody = JSON.parse(String(init?.body));
			return sseResponse([
				{
					response: {
						candidates: [{ content: { role: "model", parts: [{ text: "Hello" }] }, finishReason: "STOP" }],
						usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
					},
				},
			]);
		}) as unknown as typeof fetch;

		const events = streamGoogleAntigravity(model, context, {
			apiKey: "ya29.live",
			sessionId: "ses_wire",
			headers: { "x-goog-antigravity-project": "canvas-wallaby-dvmxc", "x-goog-api-key": "AIza-should-be-dropped" },
		});

		let text = "";
		for await (const event of events) {
			if (event.type === "text_delta") text += event.delta;
		}
		const result = await events.result();

		expect(requestUrl).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
		expect(requestHeaders?.get("authorization")).toBe("Bearer ya29.live");
		expect(requestHeaders?.get("user-agent")).toContain("antigravity/cli/");
		// A Gemini API key would authenticate the wrong client against Cloud Code.
		expect(requestHeaders?.get("x-goog-api-key")).toBeNull();
		expect(requestHeaders?.get("x-goog-antigravity-project")).toBeNull();

		expect(requestBody.project).toBe("canvas-wallaby-dvmxc");
		expect(requestBody.model).toBe("gemini-3.7-flash-high");
		expect(requestBody.userAgent).toBe("antigravity");
		expect(requestBody.requestType).toBe("agent");
		expect(requestBody.request.systemInstruction.role).toBe("user");
		expect(requestBody.request.labels.model_enum).toBe("MODEL_PLACEHOLDER_M298");
		expect(requestBody.request.labels.used_claude).toBe("false");
		expect(requestBody.request.toolConfig.functionCallingConfig.mode).toBe("VALIDATED");

		expect(text).toBe("Hello");
		expect(result.stopReason).toBe("stop");
		expect(result.usage.input).toBe(10);
		expect(result.usage.output).toBe(2);
	});

	it("emits thinking blocks and tool calls from unwrapped chunks", async () => {
		global.fetch = vi.fn(async () =>
			sseResponse([
				{
					response: {
						candidates: [
							{
								content: {
									role: "model",
									parts: [
										{ text: "considering", thought: true, thoughtSignature: "c2ln" },
										{ functionCall: { name: "read", args: { path: "README.md" }, id: "call_1" } },
									],
								},
								finishReason: "STOP",
							},
						],
					},
				},
			]),
		) as unknown as typeof fetch;

		const events = streamGoogleAntigravity(model, context, {
			apiKey: "ya29.live",
			projectId: "canvas-wallaby-dvmxc",
		});
		for await (const _event of events) {
			// exhaust
		}
		const result = await events.result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "considering", thinkingSignature: "c2ln" },
			{
				type: "toolCall",
				id: "call_1",
				name: "read",
				arguments: { path: "README.md" },
			},
		]);
	});

	it("asks for a thinking budget, never a thinking level", async () => {
		// Cloud Code v1internal answers 400 INVALID_ARGUMENT for `thinkingLevel`;
		// the official Antigravity CLI sends `thinkingBudget`.
		let sent: any;
		global.fetch = vi.fn(async (_input: any, init?: RequestInit) => {
			sent = JSON.parse(String(init?.body));
			return sseResponse([
				{ response: { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] } },
			]);
		}) as unknown as typeof fetch;

		const events = streamSimpleGoogleAntigravity(model, context, {
			apiKey: "ya29.live",
			headers: { "x-goog-antigravity-project": "canvas-wallaby-dvmxc" },
			reasoning: "high",
		});
		for await (const _event of events) {
			// exhaust
		}
		await events.result();

		const thinkingConfig = sent.request.generationConfig.thinkingConfig;
		expect(thinkingConfig.includeThoughts).toBe(true);
		expect(thinkingConfig.thinkingBudget).toBeGreaterThan(0);
		expect(thinkingConfig).not.toHaveProperty("thinkingLevel");
	});

	it("omits thinking config entirely when reasoning is off", async () => {
		let sent: any;
		global.fetch = vi.fn(async (_input: any, init?: RequestInit) => {
			sent = JSON.parse(String(init?.body));
			return sseResponse([
				{ response: { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] } },
			]);
		}) as unknown as typeof fetch;

		const events = streamSimpleGoogleAntigravity(model, context, {
			apiKey: "ya29.live",
			headers: { "x-goog-antigravity-project": "canvas-wallaby-dvmxc" },
		});
		for await (const _event of events) {
			// exhaust
		}
		await events.result();

		expect(sent.request.generationConfig?.thinkingConfig).toBeUndefined();
	});

	it("fails without an access token", async () => {
		const events = streamGoogleAntigravity(model, context, { projectId: "p" });
		for await (const _event of events) {
			// exhaust
		}
		const result = await events.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("OAuth");
	});

	it("surfaces Cloud Code error bodies", async () => {
		global.fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: { message: "quota exhausted" } }), {
					status: 429,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;

		const events = streamGoogleAntigravity(model, context, {
			apiKey: "ya29.live",
			projectId: "canvas-wallaby-dvmxc",
		});
		for await (const _event of events) {
			// exhaust
		}
		const result = await events.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("429");
		expect(result.errorMessage).toContain("quota exhausted");
		// The actionable reason, not the raw JSON envelope.
		expect(result.errorMessage).not.toContain('"error"');
	});

	it("surfaces the quota reset hint and status from a Cloud Code error", async () => {
		global.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						error: {
							code: 429,
							message: "Individual quota reached. Resets in 31m35s.",
							status: "RESOURCE_EXHAUSTED",
						},
					}),
					{ status: 429, headers: { "content-type": "application/json" } },
				),
		) as unknown as typeof fetch;

		const events = streamGoogleAntigravity(model, context, {
			apiKey: "ya29.live",
			projectId: "canvas-wallaby-dvmxc",
		});
		for await (const _event of events) {
			// exhaust
		}
		const result = await events.result();
		expect(result.errorMessage).toContain("Resets in 31m35s.");
		expect(result.errorMessage).toContain("RESOURCE_EXHAUSTED");
	});
});
