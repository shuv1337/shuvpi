import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import type { Context } from "../src/types.ts";

describe("Anthropic OAuth request identity", () => {
	const context: Context = {
		systemPrompt:
			"You are an expert coding assistant operating inside shuvpi, a coding agent harness. Follow the project instructions and read Shuvpi documentation.",
		messages: [{ role: "user", content: "ping", timestamp: 1 }],
	};

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("matches the official Claude Code OAuth request contract on the wire", async () => {
		let request: Request | undefined;
		const fetchMock: typeof fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			request = new Request(input, init);
			return new Response("", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const model = getModel("anthropic", "claude-opus-4-8");
		const oauthToken = "sk-ant-oat01-test-token";
		const stream = streamAnthropic(model, context, {
			apiKey: oauthToken,
			sessionId: "session-test",
		});

		for await (const _event of stream) {
			// Consume the mocked HTTP stream so request creation runs.
		}

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(request).toBeDefined();
		const url = new URL(request!.url);
		expect(url.pathname).toBe("/v1/messages");
		expect(url.searchParams.get("beta")).toBe("true");
		expect(request!.headers.get("authorization")).toBe(`Bearer ${oauthToken}`);
		expect(request!.headers.get("x-api-key")).toBeNull();
		expect(request!.headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
		expect(request!.headers.get("user-agent")).toBe("claude-cli/2.1.207 (external, cli)");
		expect(request!.headers.get("x-app")).toBe("cli");
		expect(request!.headers.get("x-claude-code-session-id")).toBe("session-test");
		expect(request!.headers.get("anthropic-beta")?.split(",")).toEqual(
			expect.arrayContaining(["claude-code-20250219", "oauth-2025-04-20"]),
		);

		const body = (await request!.json()) as { system: Array<{ text: string }> };
		expect(body.system[0]?.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
		expect(body.system[1]?.text).toBe(
			"You are Claude Code, Anthropic's official CLI for Claude. Follow the project instructions and read Claude documentation.",
		);
	});
});
