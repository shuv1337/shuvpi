import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Context } from "../src/types.ts";

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		messages: {
			create: () => ({
				asResponse: async () => response,
			}),
		},
	} as unknown as Anthropic;
}

const refusalEvents = [
	{
		event: "message_start",
		data: JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_refusal",
				usage: {
					input_tokens: 8,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		}),
	},
	{
		event: "message_delta",
		data: JSON.stringify({
			type: "message_delta",
			delta: {
				stop_reason: "refusal",
				stop_details: { category: "cyber", explanation: "request involves offensive cyber capability" },
			},
			usage: {
				input_tokens: 8,
				output_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		}),
	},
	{
		event: "message_stop",
		data: JSON.stringify({ type: "message_stop" }),
	},
];

describe("Anthropic refusal stop_details", () => {
	it("surfaces refusal category and explanation on the AssistantMessage", async () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		const context: Context = {
			messages: [{ role: "user", content: "...", timestamp: Date.now() }],
		};

		const response = createSseResponse(refusalEvents);
		const client = createFakeAnthropicClient(response);

		const stream = streamAnthropic(model, context, {
			apiKey: "fake-key",
			client,
			thinkingEnabled: false,
		});

		const result = await stream.result();

		// `refusal` maps to stop reason "error" but with structured details.
		expect(result.stopReason).toBe("error");
		expect(result.stopDetails).toEqual({
			type: "refusal",
			category: "cyber",
			explanation: "request involves offensive cyber capability",
		});
	});

	it("leaves stopDetails undefined on a normal end_turn", async () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		};

		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_ok",
						usage: {
							input_tokens: 2,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				}),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "ok" },
				}),
			},
			{
				event: "content_block_stop",
				data: JSON.stringify({ type: "content_block_stop", index: 0 }),
			},
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_details: null },
					usage: {
						input_tokens: 2,
						output_tokens: 1,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			},
			{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
		]);
		const client = createFakeAnthropicClient(response);

		const stream = streamAnthropic(model, context, {
			apiKey: "fake-key",
			client,
			thinkingEnabled: false,
		});

		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(result.stopDetails).toBeUndefined();
	});
});
