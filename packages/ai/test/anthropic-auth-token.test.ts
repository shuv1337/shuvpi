import { arch, platform, release } from "node:os";
import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { ANTHROPIC_AUTH_TOKEN_ENV, ANTHROPIC_OAUTH_TOKEN_ENV } from "../src/env-api-keys.ts";
import { createModels } from "../src/models.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import type { FetchFunction, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const SHUVPI_USER_AGENT = `shuvpi (${platform()} ${release()}; ${arch()})`;
const CLAUDE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const SHUVPI_IDENTITY = "You are an expert coding assistant operating inside shuvpi, a coding agent harness.";
const neverAbortedSignal = new AbortController().signal;
const context = normalizeContext({
	systemPrompt: "System prompt.",
	messages: [{ role: "user", content: "Hello", timestamp: 1 }],
});
const anthropicModel: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 4096,
};
const kimiCodingModel: Model<"anthropic-messages"> = {
	...anthropicModel,
	id: "kimi-for-coding",
	provider: "kimi-coding",
	baseUrl: "https://api.kimi.com/coding",
};
const copilotModel: Model<"anthropic-messages"> = {
	...anthropicModel,
	provider: "github-copilot",
	baseUrl: "https://api.githubcopilot.com",
};
type CapturedRequest = { url: URL; headers: Headers; body: MessageCreateParamsStreaming; signal: AbortSignal };
const requests: CapturedRequest[] = [];
const fakeFetch: FetchFunction = async (input, init) => {
	const request = new Request(input, init);
	requests.push({
		url: new URL(request.url),
		headers: request.headers,
		body: JSON.parse(await request.text()) as MessageCreateParamsStreaming,
		signal: request.signal,
	});
	const events = [
		{
			type: "message_start",
			message: { id: "msg_test", model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } },
		},
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
};
beforeEach(() => {
	requests.length = 0;
	vi.stubGlobal("fetch", fakeFetch);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("Anthropic auth token env", () => {
	it("resolves ANTHROPIC_AUTH_TOKEN as bearer auth with precedence over other keys", async () => {
		const auth = await anthropicProvider().auth.apiKey?.resolve({
			ctx: {
				env: async (name) =>
					({
						ANTHROPIC_AUTH_TOKEN: "auth-token",
						ANTHROPIC_OAUTH_TOKEN: "oauth-token",
						ANTHROPIC_API_KEY: "api-key",
					})[name],
				fileExists: async () => false,
			},
			signal: neverAbortedSignal,
		});
		expect(auth).toEqual({
			auth: { headers: { Authorization: "Bearer auth-token" } },
			source: ANTHROPIC_AUTH_TOKEN_ENV,
		});
	});
	it("preserves ANTHROPIC_OAUTH_TOKEN precedence and OAuth-shaped API auth", async () => {
		const auth = await anthropicProvider().auth.apiKey?.resolve({
			ctx: {
				env: async (name) => ({ ANTHROPIC_OAUTH_TOKEN: "oauth-token", ANTHROPIC_API_KEY: "api-key" })[name],
				fileExists: async () => false,
			},
			signal: neverAbortedSignal,
		});
		expect(auth).toEqual({ auth: { apiKey: "oauth-token" }, source: ANTHROPIC_OAUTH_TOKEN_ENV });
	});
	it("uses header-owned bearer auth without OAuth request shaping", async () => {
		expect(
			(
				await streamAnthropic(anthropicModel, context, {
					headers: { Authorization: "Bearer gateway-token" },
					fetch: fakeFetch,
				}).result()
			).stopReason,
		).toBe("stop");
		expect(requests[0].headers.get("authorization")).toBe("Bearer gateway-token");
		expect(requests[0].headers.get("x-api-key")).toBeNull();
		expect(requests[0].headers.get("anthropic-beta") ?? "").not.toContain("oauth-");
		expect(requests[0].body.system).toEqual([expect.objectContaining({ text: "System prompt." })]);
	});
	it("threads authContext bearer auth and permits an explicit request override", async () => {
		const models = createModels({
			authContext: {
				env: async (name) => (name === "ANTHROPIC_AUTH_TOKEN" ? "ctx-token" : undefined),
				fileExists: async () => false,
			},
		});
		models.setProvider(anthropicProvider());
		await models.streamSimple(anthropicModel, context, { fetch: fakeFetch }).result();
		await models
			.streamSimple(anthropicModel, context, {
				fetch: fakeFetch,
				headers: { Authorization: "Bearer explicit-token" },
			})
			.result();
		expect(requests[0].headers.get("authorization")).toBe("Bearer ctx-token");
		expect(requests[1].headers.get("authorization")).toBe("Bearer explicit-token");
		expect(requests[0].headers.get("anthropic-beta") ?? "").not.toContain("oauth-");
		expect(requests[0].body.system).toEqual([expect.objectContaining({ text: "System prompt." })]);
	});
	it("preserves OAuth request shaping through the model collection", async () => {
		const models = createModels({
			authContext: {
				env: async (name) => (name === "ANTHROPIC_OAUTH_TOKEN" ? "sk-ant-oat-test" : undefined),
				fileExists: async () => false,
			},
		});
		models.setProvider(anthropicProvider());
		await models.streamSimple(anthropicModel, context, { fetch: fakeFetch }).result();
		expect(requests[0].headers.get("authorization")).toBe("Bearer sk-ant-oat-test");
		expect(requests[0].headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
		expect(requests[0].body.system).toEqual([
			expect.objectContaining({ text: CLAUDE_IDENTITY }),
			expect.objectContaining({ text: "System prompt." }),
		]);
	});
});

describe("Anthropic OAuth routing and client identity", () => {
	it("sends Claude CLI identity and session with prompt caching disabled", async () => {
		await streamAnthropic(anthropicModel, context, {
			apiKey: "sk-ant-oat-test",
			sessionId: "session-123",
			cacheRetention: "none",
			fetch: fakeFetch,
		}).result();
		expect(requests[0].url.toString()).toBe("https://api.anthropic.com/v1/messages?beta=true");
		expect(requests[0].headers.get("user-agent")).toMatch(/^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/);
		expect(requests[0].headers.get("x-app")).toBe("cli");
		expect(requests[0].headers.get("x-claude-code-session-id")).toBe("session-123");
	});
	it.each([
		["OAuth", anthropicModel, "sk-ant-oat-test", "true"],
		["API key", anthropicModel, "api-key", null],
		["Kimi", kimiCodingModel, "kimi-key", null],
		["Copilot", copilotModel, "sk-ant-oat-copilot-token", null],
	] as const)("adds the URL safeguard only for %s when SDK beta is absent", async (_label, model, apiKey, beta) => {
		// SDK 0.124 adds beta=true for every beta call. Simulate an older SDK/gateway
		// omitting it to exercise the selected OAuth-only safeguard.
		const original = Anthropic.prototype.buildRequest;
		vi.spyOn(Anthropic.prototype, "buildRequest").mockImplementation(async function (this: Anthropic, ...args) {
			const result = await original.apply(this, args);
			const url = new URL(result.url);
			url.searchParams.delete("beta");
			url.searchParams.set("trace", "keep");
			return { ...result, url: url.toString() };
		});
		await streamAnthropic(model, context, { apiKey, fetch: fakeFetch, sessionId: "session-123" }).result();
		expect(requests[0].url.searchParams.get("beta")).toBe(beta);
		expect(requests[0].url.searchParams.get("trace")).toBe("keep");
		if (model.provider === "github-copilot") {
			expect(requests[0].headers.get("x-initiator")).toBe("user");
			expect(requests[0].headers.get("openai-intent")).toBe("conversation-edits");
			expect(requests[0].headers.get("x-app")).toBeNull();
			expect(requests[0].headers.get("x-claude-code-session-id")).toBeNull();
			expect(requests[0].headers.get("anthropic-beta") ?? "").not.toContain("oauth-");
		}
	});
	it.each(["/v1/messages?beta=false&trace=keep", "/proxy/v1/messages?trace=keep"])(
		"preserves existing beta and exact pathname scope: %s",
		async (path) => {
			const original = Anthropic.prototype.buildRequest;
			vi.spyOn(Anthropic.prototype, "buildRequest").mockImplementation(async function (this: Anthropic, ...args) {
				const result = await original.apply(this, args);
				return { ...result, url: `https://api.anthropic.com${path}` };
			});
			await streamAnthropic(anthropicModel, context, { apiKey: "sk-ant-oat-test", fetch: fakeFetch }).result();
			expect(requests[0].url.toString()).toBe(`https://api.anthropic.com${path}`);
		},
	);
	it("preserves Request inputs, method, body and headers while adding beta", async () => {
		const original = Anthropic.prototype.fetchWithTimeout;
		vi.spyOn(Anthropic.prototype, "fetchWithTimeout").mockImplementation(async function (
			this: Anthropic,
			url,
			init,
			...args
		) {
			const requestUrl = new URL(url instanceof Request ? url.url : url);
			requestUrl.searchParams.delete("beta");
			return original.call(this, new Request(requestUrl, { method: "POST" }), init, ...args);
		});
		await streamAnthropic(anthropicModel, context, {
			apiKey: "sk-ant-oat-test",
			fetch: fakeFetch,
			headers: { "x-custom": "retained" },
			signal: new AbortController().signal,
		}).result();
		expect(requests[0].url.searchParams.get("beta")).toBe("true");
		expect(requests[0].headers.get("x-custom")).toBe("retained");
		expect(requests[0].body.model).toBe("claude-test");
		expect(requests[0].signal.aborted).toBe(false);
	});
	it.each([anthropicModel, copilotModel])("does not force a Shuvpi User-Agent for $provider", async (model) => {
		await streamAnthropic(model, context, { apiKey: "api-key", fetch: fakeFetch }).result();
		expect(requests[0].headers.get("user-agent")).not.toMatch(/^(shuvpi|pi) /);
		expect(requests[0].headers.get("x-claude-code-session-id")).toBeNull();
	});
	it("enforces the Shuvpi runtime User-Agent only for Kimi", async () => {
		await streamAnthropic(kimiCodingModel, context, {
			apiKey: "kimi-key",
			fetch: fakeFetch,
			headers: { "user-agent": "custom-client" },
		}).result();
		expect(requests[0].headers.get("user-agent")).toBe(SHUVPI_USER_AGENT);
	});
	it("honors request header overrides and null suppression over model and OAuth defaults", async () => {
		await streamAnthropic(
			{ ...anthropicModel, headers: { "User-Agent": "model-client", "X-App": "model-app", "x-model": "kept" } },
			context,
			{
				apiKey: "sk-ant-oat-test",
				sessionId: "session",
				fetch: fakeFetch,
				headers: {
					"user-agent": "request-client",
					"x-app": "request-app",
					"x-claude-code-session-id": null,
					"x-request": "kept",
					"anthropic-beta": "custom-beta",
				},
			},
		).result();
		expect(requests[0].headers.get("user-agent")).toBe("request-client");
		expect(requests[0].headers.get("x-app")).toBe("request-app");
		expect(requests[0].headers.get("x-claude-code-session-id")).toBeNull();
		expect(requests[0].headers.get("x-model")).toBe("kept");
		expect(requests[0].headers.get("x-request")).toBe("kept");
		expect(requests[0].headers.get("anthropic-beta")).toBe("custom-beta");
	});
	it("preserves explicit beta and user-agent suppression for API keys", async () => {
		await streamAnthropic(anthropicModel, context, {
			apiKey: "api-key",
			fetch: fakeFetch,
			headers: { "anthropic-beta": null, "User-Agent": null },
		}).result();
		expect(requests[0].headers.get("anthropic-beta")).toBeNull();
		expect(requests[0].headers.get("user-agent")).toBeNull();
	});
});

describe("Anthropic OAuth initial system rewrite", () => {
	const initial = `${SHUVPI_IDENTITY}\nSHUVPI shuvpiPlugin /opt/ShUvPi/config; pi pipeline Claude remain.`;
	const nativeContext = normalizeContext({
		messages: [
			{ role: "system", content: initial, timestamp: 1 },
			{ role: "user", content: "User Shuvpi remains", timestamp: 2 },
			{ role: "system", content: "Later Shuvpi remains", timestamp: 3 },
		],
	});
	const nativeModel = { ...anthropicModel, compat: { supportsMidConvoSystemMessages: true } };
	it("rewrites the exact identity and all matching initial substrings only for OAuth", async () => {
		await streamAnthropic(nativeModel, nativeContext, {
			apiKey: "sk-ant-oat-test",
			fetch: fakeFetch,
			cacheRetention: "none",
		}).result();
		expect(requests[0].body.system).toEqual([
			{ type: "text", text: CLAUDE_IDENTITY },
			{
				type: "text",
				text: `${CLAUDE_IDENTITY}\nClaude ClaudePlugin /opt/Claude/config; pi pipeline Claude remain.`,
			},
		]);
		expect(requests[0].body.messages).toContainEqual({ role: "user", content: "User Shuvpi remains" });
		expect(requests[0].body.messages).toContainEqual({
			role: "system",
			content: [{ type: "text", text: "Later Shuvpi remains" }],
		});
	});
	it.each([
		["API key", nativeModel, "api-key"],
		["Copilot", { ...nativeModel, provider: "github-copilot" }, "sk-ant-oat-copilot-token"],
		["Kimi", { ...kimiCodingModel, compat: nativeModel.compat }, "kimi-key"],
	] as const)("preserves initial and later system text for %s", async (_label, model, apiKey) => {
		await streamAnthropic(model, nativeContext, { apiKey, fetch: fakeFetch, cacheRetention: "none" }).result();
		expect(requests[0].body.system).toEqual([{ type: "text", text: initial }]);
		expect(requests[0].body.messages).toContainEqual({
			role: "system",
			content: [{ type: "text", text: "Later Shuvpi remains" }],
		});
	});
	it("rewrites later text only when existing transcript normalization folds it into the initial block", async () => {
		await streamAnthropic(anthropicModel, nativeContext, {
			apiKey: "sk-ant-oat-test",
			fetch: fakeFetch,
			cacheRetention: "none",
		}).result();
		expect(requests[0].body.system).toEqual([
			{ type: "text", text: CLAUDE_IDENTITY },
			expect.objectContaining({ text: expect.stringContaining("Later Claude remains") }),
		]);
		expect(requests[0].body.messages).toEqual([{ role: "user", content: "User Shuvpi remains" }]);
	});
});
