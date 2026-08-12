import { describe, expect, it } from "vitest";
import {
	antigravityUserAgent,
	buildAntigravityModels,
	catalogModelId,
	filterGoogleModels,
	maxOutputFor,
	parseCatalogModels,
	unwrapSSEText,
	wrapGenerateRequest,
} from "../src/api/google-antigravity-shared.ts";
import {
	authorizeURL,
	CLIENT_ID,
	googleAntigravityOAuth,
	nextRefresh,
	parseOAuthTokenBlob,
	parseV1Accounts,
	REDIRECT_URI,
	SCOPES,
	splitRefresh,
} from "../src/auth/oauth/google-antigravity.ts";
import { builtinProviders } from "../src/providers/all.ts";
import { googleProvider } from "../src/providers/google.ts";
import { googleAntigravityProvider } from "../src/providers/google-antigravity.ts";

const nativeBody = {
	contents: [{ role: "user", parts: [{ text: "hello" }] }],
	systemInstruction: { parts: [{ text: "be brief" }] },
	tools: [
		{
			functionDeclarations: [
				{
					name: "read",
					description: "Read a file",
					parameters: {
						$schema: "https://json-schema.org/draft/2020-12/schema",
						type: "object",
						properties: {
							path: { type: "string", default: ".", const: "README.md" },
						},
						$defs: { unused: { type: "string" } },
						$ref: "#/$defs/unused",
					},
				},
			],
		},
	],
	generationConfig: { maxOutputTokens: 65536, thinkingConfig: { thinkingBudget: 1000 } },
};

describe("google antigravity oauth", () => {
	it("builds the official CLI user agent and authorize URL", () => {
		expect(antigravityUserAgent()).toMatch(
			/^antigravity\/cli\/1\.1\.13 \(aidev_client; os_type=(linux|darwin|windows); arch=(amd64|arm64); cl=964361259; auth_method=consumer\)$/,
		);

		const url = new URL(authorizeURL("challenge-1", "state-1"));
		expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
		expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
		expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("access_type")).toBe("offline");
		expect(url.searchParams.get("prompt")).toBe("consent");
		expect(url.searchParams.get("state")).toBe("state-1");
		expect(url.searchParams.get("scope")?.split(" ")).toEqual([...SCOPES]);
	});

	it("keeps the current refresh token when Google omits a new one", () => {
		expect(nextRefresh("1//current", undefined)).toBe("1//current");
		expect(nextRefresh("1//current", "1//next")).toBe("1//next");
	});

	it("splits a V1 refresh token carrying the project id", () => {
		expect(splitRefresh("1//token|my-project")).toEqual({ refresh: "1//token", projectId: "my-project" });
		expect(splitRefresh("1//plain")).toEqual({ refresh: "1//plain" });
	});

	it("imports V1 accounts and IDE oauth token blobs", () => {
		expect(
			parseV1Accounts(
				JSON.stringify({
					version: 2,
					activeIndex: 0,
					accounts: [{ refreshToken: "1//abc|canvas-wallaby-dvmxc", projectId: "canvas-wallaby-dvmxc" }],
				}),
			),
		).toMatchObject({ refresh: "1//abc", projectId: "canvas-wallaby-dvmxc" });

		const blob = JSON.stringify({
			refresh_token: "1//blob",
			access_token: "ya29.a",
			expires_in: 3600,
			email: "user@gmail.com",
		});
		expect(parseOAuthTokenBlob(blob)).toMatchObject({
			refresh: "1//blob",
			access: "ya29.a",
			email: "user@gmail.com",
		});
		expect(parseOAuthTokenBlob(Buffer.from(blob, "utf8").toString("base64"))).toMatchObject({ refresh: "1//blob" });
		expect(parseOAuthTokenBlob(`prefix-garbage${blob}suffix`)).toMatchObject({ refresh: "1//blob" });
		expect(parseOAuthTokenBlob("not-json")).toBeUndefined();
	});

	it("derives request auth from a stored credential", async () => {
		const auth = await googleAntigravityOAuth.toAuth({
			type: "oauth",
			access: "ya29.live",
			refresh: "1//live",
			expires: Date.now() + 3_600_000,
			projectId: "canvas-wallaby-dvmxc",
		});
		expect(auth.apiKey).toBe("ya29.live");
		expect(auth.headers).toEqual({ "x-goog-antigravity-project": "canvas-wallaby-dvmxc" });

		const withoutProject = await googleAntigravityOAuth.toAuth({
			type: "oauth",
			access: "ya29.live",
			refresh: "1//live",
			expires: Date.now() + 3_600_000,
		});
		expect(withoutProject.headers).toBeUndefined();
	});
});

describe("google antigravity wire", () => {
	it("wraps a native Gemini body in the Cloud Code envelope", () => {
		const wrapped = wrapGenerateRequest({
			body: nativeBody,
			projectId: "canvas-wallaby-dvmxc",
			model: "gemini-3.7-flash-low",
			sessionID: "ses_test",
			modelEnum: "MODEL_PLACEHOLDER_M300",
			now: 1_700_000_000_000,
			trajectory: "traj-1",
		}) as {
			project: string;
			requestId: string;
			model: string;
			userAgent: string;
			requestType: string;
			request: {
				systemInstruction: { role: string };
				toolConfig: { functionCallingConfig: { mode: string } };
				tools: Array<{ functionDeclarations: Array<{ parameters: Record<string, unknown> }> }>;
				labels: Record<string, string>;
				generationConfig: { thinkingConfig: { includeThoughts: boolean; thinkingBudget: number } };
				sessionId: string;
			};
		};

		expect(wrapped.project).toBe("canvas-wallaby-dvmxc");
		expect(wrapped.model).toBe("gemini-3.7-flash-low");
		expect(wrapped.userAgent).toBe("antigravity");
		expect(wrapped.requestType).toBe("agent");
		expect(wrapped.requestId).toBe("agent/ses_test/1700000000000/traj-1/2");
		expect(wrapped.request.systemInstruction.role).toBe("user");
		expect(wrapped.request.toolConfig.functionCallingConfig.mode).toBe("VALIDATED");
		expect(wrapped.request.labels).toEqual({
			last_step_index: "1",
			model_enum: "MODEL_PLACEHOLDER_M300",
			request_id: "traj-1-0",
			trajectory_id: "traj-1",
			used_claude: "false",
			used_claude_conservative: "false",
			used_non_gemini_model: "false",
		});
		expect(wrapped.request.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 1000 });
		expect(wrapped.request.tools[0]?.functionDeclarations[0]?.parameters).toEqual({
			type: "object",
			properties: { path: { type: "string", enum: ["README.md"] } },
		});
		// Session ids must be a stable unsigned 64-bit number, never negative.
		expect(wrapped.request.sessionId).toMatch(/^\d+$/);
		expect(
			(wrapGenerateRequest({ body: {}, projectId: "p", model: "m", sessionID: "ses_test" }) as any).request
				.sessionId,
		).toBe(wrapped.request.sessionId);
	});

	it("maps the deprecated 3.1 Pro alias and never marks Claude usage", () => {
		expect(catalogModelId("gemini-3.1-pro-high")).toBe("gemini-pro-agent");
		expect(catalogModelId("gemini-3.7-flash-high")).toBe("gemini-3.7-flash-high");

		const wrapped = wrapGenerateRequest({
			body: { contents: [] },
			projectId: "proj",
			model: "gemini-3.1-pro-high",
			sessionID: "ses_x",
			trajectory: "t",
			now: 1,
		}) as { model: string; request: { labels: Record<string, string> } };
		expect(wrapped.model).toBe("gemini-pro-agent");
		expect(wrapped.request.labels.used_claude).toBe("false");
		expect(wrapped.request.labels.used_non_gemini_model).toBe("false");
	});

	it("leaves an already wrapped body untouched", () => {
		const already = { project: "p", model: "m", request: { contents: [] } };
		expect(wrapGenerateRequest({ body: already, projectId: "other", model: "x", sessionID: "s" })).toBe(already);
	});

	it("unwraps Cloud Code SSE response envelopes", () => {
		const native = { candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }] };
		const text = `data: ${JSON.stringify({ response: native, traceId: "tr", metadata: {} })}\n\ndata: [DONE]\n`;
		expect(unwrapSSEText(text)).toBe(`data: ${JSON.stringify(native)}\n\ndata: [DONE]\n`);
	});

	it("filters Claude, GPT, tab, and image models out of the Cloud Code catalog", () => {
		const filtered = filterGoogleModels([
			{ id: "gemini-3.7-flash-high", provider: "MODEL_PROVIDER_GOOGLE", recommended: true },
			{ id: "claude-sonnet-4-6", provider: "MODEL_PROVIDER_ANTHROPIC", recommended: true },
			{ id: "gpt-oss-120b-medium", provider: "MODEL_PROVIDER_OPENAI", recommended: true },
			{ id: "tab_flash_lite_preview", provider: "MODEL_PROVIDER_GOOGLE" },
			{ id: "gemini-3.1-flash-image", provider: "MODEL_PROVIDER_GOOGLE" },
			{ id: "chat_20706", provider: "MODEL_PROVIDER_GOOGLE", internal: true },
		]);
		expect(filtered.map((model) => model.id)).toEqual(["gemini-3.7-flash-high"]);
	});

	it("parses a fetchAvailableModels payload", () => {
		expect(
			parseCatalogModels({
				models: [
					{
						id: "gemini-3.7-flash-high",
						displayName: "Gemini 3.7 Flash (High)",
						model: "MODEL_PLACEHOLDER_M298",
						modelProvider: "MODEL_PROVIDER_GOOGLE",
					},
					{ nothing: true },
				],
			}),
		).toEqual([
			{
				id: "gemini-3.7-flash-high",
				name: "Gemini 3.7 Flash (High)",
				modelEnum: "MODEL_PLACEHOLDER_M298",
				provider: "MODEL_PROVIDER_GOOGLE",
				internal: false,
				recommended: false,
			},
		]);
	});

	it("builds a subscription catalog that keeps only Google models", () => {
		const models = buildAntigravityModels("google-antigravity", [
			{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", provider: "MODEL_PROVIDER_GOOGLE" },
			{ id: "claude-opus-5", name: "Claude Opus 5", provider: "MODEL_PROVIDER_ANTHROPIC" },
		]);
		const ids = models.map((model) => model.id);
		expect(ids).toContain("gemini-3.7-flash-high");
		expect(ids).toContain("gemini-3.8-flash-high");
		expect(ids).not.toContain("claude-opus-5");
		for (const model of models) {
			expect(model.provider).toBe("google-antigravity");
			expect(model.api).toBe("google-antigravity");
			expect(model.baseUrl).toContain("cloudcode");
			// Subscription usage is quota-metered, not billed per token.
			expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		}
	});

	it("caps Pro output below Flash", () => {
		// Cloud Code answers 400 INVALID_ARGUMENT when maxOutputTokens exceeds the
		// model's real cap, and the Pro agent rejects Flash's 65536.
		const models = buildAntigravityModels("google-antigravity", [
			{ id: "gemini-4-pro-high", name: "Gemini 4 Pro (High)", provider: "MODEL_PROVIDER_GOOGLE" },
			{ id: "gemini-4-flash-high", name: "Gemini 4 Flash (High)", provider: "MODEL_PROVIDER_GOOGLE" },
		]);
		const byId = new Map(models.map((model) => [model.id, model]));

		for (const id of ["gemini-pro-agent", "gemini-3.1-pro-high", "gemini-3.1-pro-low", "gemini-4-pro-high"]) {
			expect(byId.get(id)?.maxTokens, id).toBe(32_768);
		}
		for (const id of ["gemini-3.7-flash-high", "gemini-3-flash-agent", "gemini-4-flash-high"]) {
			expect(byId.get(id)?.maxTokens, id).toBe(65_536);
		}
		for (const model of models) expect(model.contextWindow).toBe(1_048_576);

		expect(maxOutputFor("gemini-pro-agent")).toBe(32_768);
		expect(maxOutputFor("gemini-3.7-flash-high")).toBe(65_536);
	});
});

describe("googleAntigravityProvider", () => {
	it("is subscription-only and ships a usable catalog before the first refresh", () => {
		const provider = googleAntigravityProvider();
		expect(provider.id).toBe("google-antigravity");
		expect(provider.auth.oauth?.name).toBe("Google AI Pro / Antigravity");
		expect(provider.auth.oauth?.isSubscription).toBe(true);
		// Cloud Code does not accept a Gemini API key, so no api-key path exists.
		expect(provider.auth.apiKey).toBeUndefined();

		const ids = provider.getModels().map((model) => model.id);
		expect(ids).toContain("gemini-3.7-flash-high");
		expect(ids.some((id) => id.startsWith("claude") || id.startsWith("gpt"))).toBe(false);
	});

	it("leaves the api-key Google provider untouched", () => {
		const provider = googleProvider();
		expect(provider.auth.apiKey?.name).toBe("Gemini API key");
		expect(provider.auth.oauth).toBeUndefined();
		const ids = provider.getModels().map((model) => model.id);
		expect(ids).toContain("gemini-2.5-flash");
		expect(ids).not.toContain("gemini-3.7-flash-high");
	});

	it("registers alongside the other built-in providers", () => {
		const provider = builtinProviders().find((entry) => entry.id === "google-antigravity");
		expect(provider?.name).toBe("Google AI Pro");
		expect(provider?.auth.oauth).toBeDefined();
	});
});
