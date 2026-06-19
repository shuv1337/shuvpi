import { afterEach, describe, expect, it, vi } from "vitest";
import {
	grokSupportsReasoningEffort,
	isXaiResponsesTarget,
	resolveCodexUrl,
} from "../src/providers/openai-codex-responses.ts";
import { exchangeXaiAuthorizationCode, XAI_OAUTH_CLIENT_ID } from "../src/utils/oauth/xai-oauth.ts";

describe("resolveCodexUrl (xAI)", () => {
	it("maps api.x.ai/v1 to /v1/responses", () => {
		expect(resolveCodexUrl("https://api.x.ai/v1")).toBe("https://api.x.ai/v1/responses");
	});

	it("keeps ChatGPT codex path", () => {
		expect(resolveCodexUrl("https://chatgpt.com/backend-api")).toBe(
			"https://chatgpt.com/backend-api/codex/responses",
		);
	});
});

describe("isXaiResponsesTarget", () => {
	it("detects xai-oauth provider", () => {
		expect(isXaiResponsesTarget({ provider: "xai-oauth", baseUrl: "https://api.x.ai/v1" })).toBe(true);
	});
});

describe("grokSupportsReasoningEffort", () => {
	it("rejects grok-composer-2.5-fast", () => {
		expect(grokSupportsReasoningEffort("grok-composer-2.5-fast")).toBe(false);
	});
	it("accepts grok-3-mini", () => {
		expect(grokSupportsReasoningEffort("grok-3-mini")).toBe(true);
	});
});

describe("exchangeXaiAuthorizationCode", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends code_verifier and code_challenge to token endpoint", async () => {
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = init?.body?.toString() ?? "";
			expect(body).toContain("code_verifier=verifier-abc");
			expect(body).toContain("code_challenge=challenge-xyz");
			expect(body).toContain("code_challenge_method=S256");
			expect(body).toContain(`client_id=${XAI_OAUTH_CLIENT_ID}`);
			return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const payload = await exchangeXaiAuthorizationCode({
			tokenEndpoint: "https://auth.x.ai/oauth2/token",
			code: "auth-code",
			redirectUri: "http://127.0.0.1:56121/callback",
			codeVerifier: "verifier-abc",
			codeChallenge: "challenge-xyz",
		});

		expect(payload.access_token).toBe("at");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("refuses empty code_verifier", async () => {
		await expect(
			exchangeXaiAuthorizationCode({
				tokenEndpoint: "https://auth.x.ai/oauth2/token",
				code: "c",
				redirectUri: "http://127.0.0.1:56121/callback",
				codeVerifier: "",
				codeChallenge: "ch",
			}),
		).rejects.toThrow(/code_verifier is empty/);
	});
});
