import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { AssistantMessage, Context, Message, Model } from "../src/types.ts";

// Regression test for the "thinking blocks in the latest assistant message cannot
// be modified" 400 that bricked Opus 4.8 sessions. Adaptive thinking emits a
// trailing thinking block after tool calls; once that turn is no longer the most
// recent assistant message, replaying its thinking trips the API. We strip
// thinking from every assistant turn except the last one.

interface CapturedPayload {
	messages: Array<{
		role: string;
		content: string | Array<{ type: string }>;
	}>;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function fakeOpus48(): Model<"anthropic-messages"> {
	return { ...getModel("anthropic", "claude-opus-4-8"), baseUrl: "http://127.0.0.1:9" };
}

async function capturePayload(context: Context): Promise<CapturedPayload> {
	let captured: CapturedPayload | undefined;
	const s = streamAnthropic(fakeOpus48(), context, {
		apiKey: "fake-key",
		thinkingEnabled: true,
		onPayload: (payload) => {
			captured = payload as CapturedPayload;
			throw new PayloadCaptured();
		},
	});
	await s.result();
	if (!captured) throw new Error("Expected payload to be captured before request failure");
	return captured;
}

function assistantTurn(thinkingText: string, sig: string): AssistantMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-4-8",
		content: [
			{ type: "thinking", thinking: "leading thought", thinkingSignature: `${sig}-lead` },
			{ type: "toolCall", id: `tc-${sig}`, name: "bash", arguments: { command: "echo hi" } },
			// trailing thinking block after the tool call — the shape Opus 4.8 emits
			{ type: "thinking", thinking: thinkingText, thinkingSignature: `${sig}-trail` },
		],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	} as AssistantMessage;
}

function toolResult(id: string): Message {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
		content: [{ type: "text", text: "hi" }],
		isError: false,
		timestamp: Date.now(),
	} as Message;
}

describe("Anthropic historical thinking stripping", () => {
	it("strips thinking from non-latest assistant turns and keeps the latest", async () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "first", timestamp: Date.now() },
				assistantTurn("waiting on tool A", "a"),
				toolResult("tc-a"),
				assistantTurn("waiting on tool B", "b"),
				toolResult("tc-b"),
				{ role: "user", content: "continue", timestamp: Date.now() },
			],
		};

		const payload = await capturePayload(context);
		const assistants = payload.messages.filter((m) => m.role === "assistant");
		expect(assistants.length).toBe(2);

		const blockTypes = (m: { content: string | Array<{ type: string }> }) =>
			Array.isArray(m.content) ? m.content.map((b) => b.type) : [];

		// First (historical) assistant turn: no thinking blocks remain
		expect(blockTypes(assistants[0])).not.toContain("thinking");
		expect(blockTypes(assistants[0])).toContain("tool_use");

		// Latest assistant turn: thinking blocks preserved for replay continuity
		expect(blockTypes(assistants[1])).toContain("thinking");
	});
});
