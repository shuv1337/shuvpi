import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import type { Context } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	constructorOptions: undefined as Record<string, unknown> | undefined,
	requestParams: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@anthropic-ai/sdk", () => {
	class FakeAnthropic {
		constructor(options: Record<string, unknown>) {
			mockState.constructorOptions = options;
		}

		messages = {
			create: (params: Record<string, unknown>) => {
				mockState.requestParams = params;
				return {
					asResponse: async () =>
						new Response("", {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						}),
				};
			},
		};
	}

	return { default: FakeAnthropic };
});

describe("Anthropic OAuth request identity", () => {
	const context: Context = {
		systemPrompt: "Follow the project instructions.",
		messages: [{ role: "user", content: "ping", timestamp: 1 }],
	};

	beforeEach(() => {
		mockState.constructorOptions = undefined;
		mockState.requestParams = undefined;
	});

	it("matches the official Claude Code OAuth request contract", async () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		const oauthToken = "sk-ant-oat01-test-token";
		const stream = streamAnthropic(model, context, {
			apiKey: oauthToken,
			sessionId: "session-test",
		});

		for await (const _event of stream) {
			// Consume the mocked stream so client construction and request creation run.
		}

		expect(mockState.constructorOptions).toMatchObject({
			apiKey: null,
			authToken: oauthToken,
		});
		const headers = mockState.constructorOptions?.defaultHeaders as Record<string, string>;
		expect(headers).toMatchObject({
			"anthropic-dangerous-direct-browser-access": "true",
			"user-agent": "claude-cli/2.1.207 (external, cli)",
			"x-app": "cli",
			"X-Claude-Code-Session-Id": "session-test",
		});
		expect(headers["anthropic-beta"].split(",")).toEqual(
			expect.arrayContaining(["claude-code-20250219", "oauth-2025-04-20"]),
		);

		const system = mockState.requestParams?.system as Array<{ text: string }>;
		expect(system[0]?.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
		expect(system[1]?.text).toBe(context.systemPrompt);
	});
});
