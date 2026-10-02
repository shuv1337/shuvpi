import { afterEach, describe, expect, it, vi } from "vitest";
import { xaiOAuth } from "../src/auth/oauth/xai.ts";

describe("xAI OAuth refresh", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("keeps the existing refresh token when xAI omits token rotation", async () => {
		const now = new Date("2026-10-02T20:00:00.000Z");
		vi.useFakeTimers();
		vi.setSystemTime(now);
		let requestUrl = "";
		let requestBody = "";
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			requestUrl = String(input);
			requestBody = String(init?.body);
			return new Response(JSON.stringify({ access_token: "access-rotated", expires_in: 3600 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const refreshed = await xaiOAuth.refresh(
			{ type: "oauth", access: "access-old", refresh: "refresh-stable", expires: now.getTime() },
			new AbortController().signal,
		);

		expect(requestUrl).toBe("https://auth.x.ai/oauth2/token");
		expect(Object.fromEntries(new URLSearchParams(requestBody))).toEqual({
			grant_type: "refresh_token",
			client_id: "b1a00492-073a-47ea-816f-4c329264a828",
			refresh_token: "refresh-stable",
		});
		expect(refreshed).toEqual({
			type: "oauth",
			access: "access-rotated",
			refresh: "refresh-stable",
			expires: now.getTime() + 3_600_000 - 5 * 60_000,
		});
	});
});
