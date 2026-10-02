import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamCodex } from "../src/api/openai-codex-responses.ts";
import { stream as streamOpenAI } from "../src/api/openai-responses.ts";
import type { Model, StreamOptions } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 0 }] });
const openaiModel: Model<"openai-responses"> = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};
const codexModel: Model<"openai-codex-responses"> = {
	...openaiModel,
	provider: "openai-codex",
	api: "openai-codex-responses",
};

function completed(serviceTier?: string): Record<string, unknown> {
	return {
		type: "response.completed",
		response: {
			id: "response-test",
			object: "response",
			status: "completed",
			output: [],
			usage: { input_tokens: 1000, output_tokens: 1000, total_tokens: 2000 },
			...(serviceTier ? { service_tier: serviceTier } : {}),
		},
	};
}

function bodyOf(init?: RequestInit): Record<string, unknown> {
	const body = init?.body;
	if (typeof body === "string") return JSON.parse(body);
	if (body instanceof Uint8Array) return JSON.parse(zstdDecompressSync(body).toString("utf8"));
	throw new Error("Expected request JSON or compressed bytes");
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("fast-mode payload tier pricing", () => {
	it.each([
		{ api: "openai", responseTier: undefined, finalTier: "priority", multiplier: 2 },
		{ api: "codex", responseTier: undefined, finalTier: "priority", multiplier: 2 },
		{ api: "openai", responseTier: "default", finalTier: "priority", multiplier: 1 },
		{ api: "codex", responseTier: "default", finalTier: "priority", multiplier: 2 },
		{ api: "openai", responseTier: undefined, finalTier: "flex", multiplier: 0.5 },
		{ api: "codex", responseTier: undefined, finalTier: "flex", multiplier: 0.5 },
		{ api: "openai", responseTier: "flex", finalTier: "priority", multiplier: 0.5 },
		{ api: "codex", responseTier: "flex", finalTier: "priority", multiplier: 0.5 },
		{ api: "openai", responseTier: undefined, finalTier: undefined, multiplier: 1 },
		{ api: "codex", responseTier: undefined, finalTier: undefined, multiplier: 1 },
	])(
		"prices $api final tier $finalTier with response tier $responseTier",
		async ({ api, responseTier, finalTier, multiplier }) => {
			let request: Record<string, unknown> | undefined;
			const fetch: typeof globalThis.fetch = async (_url, init) => {
				request = bodyOf(init);
				return new Response(`event: response.completed\ndata: ${JSON.stringify(completed(responseTier))}\n\n`, {
					headers: { "content-type": "text/event-stream" },
				});
			};
			const options: StreamOptions = {
				apiKey: "fake-token",
				headers: { "chatgpt-account-id": "fake-account" },
				fetch,
				transport: "sse",
				onPayload: (value) => {
					const payload = { ...(value as Record<string, unknown>), service_tier: finalTier };
					return payload;
				},
			};
			const result = await (api === "openai"
				? streamOpenAI(openaiModel, context, {
						...options,
						serviceTier: finalTier === "priority" ? undefined : "priority",
					})
				: streamCodex(codexModel, context, {
						...options,
						serviceTier: finalTier === "priority" ? undefined : "priority",
					})
			).result();
			expect(result.stopReason, result.errorMessage).toBe("stop");
			expect(request?.service_tier).toBe(finalTier);
			expect(result.usage.cost.input).toBeCloseTo(0.001 * multiplier);
			expect(result.usage.cost.output).toBeCloseTo(0.002 * multiplier);
			expect(result.usage.cost.total).toBeCloseTo(0.003 * multiplier);
		},
	);

	it.each(["priority", "flex"] as const)("prices the final Codex WebSocket %s request", async (finalTier) => {
		let request: Record<string, unknown> | undefined;
		class FakeWebSocket extends EventTarget {
			readyState = 0;
			constructor() {
				super();
				queueMicrotask(() => {
					this.readyState = 1;
					this.dispatchEvent(new Event("open"));
				});
			}
			send(data: string): void {
				request = JSON.parse(data);
				setTimeout(
					() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(completed("default")) })),
					0,
				);
			}
			close(): void {
				this.readyState = 3;
				this.dispatchEvent(new Event("close"));
			}
		}
		vi.stubGlobal("WebSocket", FakeWebSocket);
		const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("unexpected HTTP fallback"));
		const result = await streamCodex(codexModel, context, {
			apiKey: "fake-token",
			headers: { "chatgpt-account-id": "fake-account" },
			transport: "websocket",
			fetch,
			onPayload: (value) => ({ ...(value as Record<string, unknown>), service_tier: finalTier }),
		}).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(request?.service_tier).toBe(finalTier);
		expect(result.usage.cost.total).toBeCloseTo(0.003 * (finalTier === "priority" ? 2 : 0.5));
		expect(fetch).not.toHaveBeenCalled();
	});
});
