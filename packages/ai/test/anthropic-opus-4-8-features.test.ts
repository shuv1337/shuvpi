import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Context, Model } from "../src/types.ts";

interface AnthropicPayload {
	speed?: "default" | "fast";
	messages: Array<{
		role: string;
		content: string | Array<{ type: string; text?: string }>;
	}>;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function fakeOpus48(): Model<"anthropic-messages"> {
	return {
		...getModel("anthropic", "claude-opus-4-8"),
		baseUrl: "http://127.0.0.1:9",
	};
}

async function capturePayload(context: Context, extra?: { speed?: "default" | "fast" }): Promise<AnthropicPayload> {
	let captured: AnthropicPayload | undefined;
	const s = streamAnthropic(fakeOpus48(), context, {
		apiKey: "fake-key",
		thinkingEnabled: false,
		speed: extra?.speed,
		onPayload: (payload) => {
			captured = payload as AnthropicPayload;
			throw new PayloadCaptured();
		},
	});

	await s.result();

	if (!captured) {
		throw new Error("Expected payload to be captured before request failure");
	}
	return captured;
}

describe("Claude Opus 4.8 new features", () => {
	it('forwards `speed: "fast"` into the request payload', async () => {
		const payload = await capturePayload(
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ speed: "fast" },
		);

		expect(payload.speed).toBe("fast");
	});

	it("omits `speed` when not requested", async () => {
		const payload = await capturePayload({
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		});

		expect(payload.speed).toBeUndefined();
	});

	it('forwards a mid-conversation system message as a `role: "system"` MessageParam', async () => {
		const now = Date.now();
		const payload = await capturePayload({
			messages: [
				{ role: "user", content: "step 1", timestamp: now },
				{ role: "system", content: "Updated rules: respond in French.", timestamp: now + 1 },
				{ role: "user", content: "step 2", timestamp: now + 2 },
			],
		});

		const roles = payload.messages.map((m) => m.role);
		expect(roles).toEqual(["user", "system", "user"]);

		const systemMessage = payload.messages[1];
		expect(Array.isArray(systemMessage.content)).toBe(true);
		const blocks = systemMessage.content as Array<{ type: string; text?: string }>;
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({ type: "text", text: "Updated rules: respond in French." });
	});

	it("drops empty mid-conversation system messages", async () => {
		const now = Date.now();
		const payload = await capturePayload({
			messages: [
				{ role: "user", content: "step 1", timestamp: now },
				{ role: "system", content: "   ", timestamp: now + 1 },
				{ role: "user", content: "step 2", timestamp: now + 2 },
			],
		});

		expect(payload.messages.map((m) => m.role)).toEqual(["user", "user"]);
	});
});
