import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AUTHORIZE_URL,
	antigravityStatePaths,
	authorizeURL,
	CALLBACK_PORT,
	CLIENT_ID,
	completeAccount,
	exchangeAuthorizationCode,
	googleAntigravityOAuth,
	importExisting,
	parseOAuthTokenBlob,
	parseV1Accounts,
	REDIRECT_URI,
	refreshTokens,
	SCOPES,
	TOKEN_URL,
	USER_INFO_URL,
} from "../src/auth/oauth/google-antigravity.ts";
import type { AuthEvent } from "../src/auth/types.ts";

const nativeFetch = globalThis.fetch;
const signal = new AbortController().signal;
const ASSIST_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
let home: string;
const servers: Server[] = [];

function fakeNetwork(overrides: Record<string, unknown> = {}) {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		init?.signal?.throwIfAborted();
		const url = input instanceof Request ? input.url : String(input);
		const responses: Record<string, unknown> = {
			[TOKEN_URL]: { access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 3600 },
			[ASSIST_URL]: { cloudaicompanionProject: { id: "fake-project" }, paidTier: { id: "paid" } },
			[USER_INFO_URL]: { email: "test@example.invalid" },
			...overrides,
		};
		if (!(url in responses)) throw new Error(`Unexpected network request: ${url}`);
		return Response.json(responses[url]);
	});
}

async function occupyCallback() {
	const server = createServer();
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(CALLBACK_PORT, "127.0.0.1", resolve);
	});
}

describe.sequential("Google Antigravity OAuth", () => {
	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "antigravity-oauth-"));
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
		vi.stubEnv("APPDATA", join(home, "AppData"));
		vi.stubEnv("SHUVPI_OAUTH_CALLBACK_HOST", "127.0.0.1");
		vi.stubGlobal("fetch", fakeNetwork());
	});

	afterEach(async () => {
		for (const server of servers.splice(0)) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		await rm(home, { recursive: true, force: true });
	});

	it("uses the anchored client, redirect, scopes and PKCE challenge", () => {
		const url = new URL(authorizeURL("challenge", "state"));
		expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_URL);
		expect(Object.fromEntries(url.searchParams)).toMatchObject({
			client_id: CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			code_challenge: "challenge",
			code_challenge_method: "S256",
			scope: SCOPES.join(" "),
			state: "state",
			access_type: "offline",
		});
	});

	it("completes the loopback callback and cancels the manual prompt", async () => {
		const fetchMock = fakeNetwork();
		vi.stubGlobal("fetch", fetchMock);
		let response: Promise<Response> | undefined;
		let manualSignal: AbortSignal | undefined;
		let challenge: string | null | undefined;
		const credential = await googleAntigravityOAuth.login({
			signal,
			prompt: (prompt) => {
				manualSignal = prompt.signal;
				return new Promise<string>(() => {});
			},
			notify: (event) => {
				if (event.type !== "auth_url") return;
				const url = new URL(event.url);
				challenge = url.searchParams.get("code_challenge");
				const callback = new URL(REDIRECT_URI);
				callback.hostname = "127.0.0.1";
				callback.search = new URLSearchParams({
					code: "fake-code",
					state: url.searchParams.get("state")!,
				}).toString();
				response = nativeFetch(callback);
			},
		});
		expect((await response)?.status).toBe(200);
		expect(manualSignal?.aborted).toBe(true);
		expect(credential).toMatchObject({
			type: "oauth",
			access: "fake-access",
			refresh: "fake-refresh",
			projectId: "fake-project",
			email: "test@example.invalid",
			paidTier: "paid",
		});
		const body = new URLSearchParams(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(body.get("code")).toBe("fake-code");
		expect(body.get("redirect_uri")).toBe(REDIRECT_URI);
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.get("code_verifier")!));
		expect(Buffer.from(digest).toString("base64url")).toBe(challenge);
		expect(await googleAntigravityOAuth.toAuth(credential)).toEqual({
			apiKey: "fake-access",
			headers: { "x-goog-antigravity-project": "fake-project" },
		});
	});

	it("rejects the wrong callback state without consuming the valid callback", async () => {
		let wrongResponse: Promise<Response> | undefined;
		let validResponse: Promise<Response> | undefined;
		const credential = await googleAntigravityOAuth.login({
			signal,
			prompt: () => new Promise<string>(() => {}),
			notify: (event) => {
				if (event.type !== "auth_url") return;
				const callback = new URL(REDIRECT_URI);
				callback.hostname = "127.0.0.1";
				callback.search = "?code=code&state=wrong";
				wrongResponse = nativeFetch(callback);
				validResponse = wrongResponse.then(() => {
					callback.searchParams.set("state", new URL(event.url).searchParams.get("state")!);
					return nativeFetch(callback);
				});
			},
		});
		expect((await wrongResponse)?.status).toBe(400);
		expect((await validResponse)?.status).toBe(200);
		expect(credential.projectId).toBe("fake-project");
	});

	it("surfaces provider callback errors instead of leaving login waiting", async () => {
		let response: Promise<Response> | undefined;
		await expect(
			googleAntigravityOAuth.login({
				signal,
				prompt: () => new Promise<string>(() => {}),
				notify: (event) => {
					if (event.type !== "auth_url") return;
					const callback = new URL(REDIRECT_URI);
					callback.hostname = "127.0.0.1";
					callback.search = new URLSearchParams({
						error: "access_denied",
						state: new URL(event.url).searchParams.get("state")!,
					}).toString();
					response = nativeFetch(callback);
				},
			}),
		).rejects.toThrow("access_denied");
		expect((await response)?.status).toBe(400);
	});

	it("accepts a pasted redirect when the callback port is unavailable", async () => {
		await occupyCallback();
		const events: AuthEvent[] = [];
		let state = "";
		const credential = await googleAntigravityOAuth.login({
			signal,
			prompt: async () => `${REDIRECT_URI}?code=pasted&state=${state}`,
			notify: (event) => {
				events.push(event);
				if (event.type === "auth_url") state = new URL(event.url).searchParams.get("state")!;
			},
		});
		expect(credential.projectId).toBe("fake-project");
		expect(events.some((event) => event.type === "info" && event.message.includes("callback unavailable"))).toBe(
			true,
		);
	});

	it.each([false, true])("cancels a pending manual prompt with unavailable callback=%s", async (unavailable) => {
		if (unavailable) await occupyCallback();
		const controller = new AbortController();
		let manualSignal: AbortSignal | undefined;
		await expect(
			googleAntigravityOAuth.login({
				signal: controller.signal,
				prompt: (prompt) => {
					manualSignal = prompt.signal;
					controller.abort();
					return new Promise<string>(() => {});
				},
				notify: () => {},
			}),
		).rejects.toThrow("Login cancelled");
		expect(manualSignal?.aborted).toBe(true);
	});

	it.each(["", `${REDIRECT_URI}?code=code&state=wrong`])("rejects invalid manual input %s", async (input) => {
		const fetchMock = fakeNetwork();
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			googleAntigravityOAuth.login({ signal, prompt: async () => input, notify: () => {} }),
		).rejects.toThrow(input ? "state mismatch" : "Missing authorization code");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("parses existing account and IDE token formats", () => {
		expect(
			parseV1Accounts(
				JSON.stringify({
					activeIndex: 1,
					accounts: [
						{ refreshToken: "other" },
						{ refreshToken: "refresh|project", email: "test@example.invalid" },
					],
				}),
			),
		).toMatchObject({ refresh: "refresh", projectId: "project", email: "test@example.invalid" });
		const token = JSON.stringify({ refresh_token: "refresh", access_token: "access", expiry_date: 123 });
		for (const blob of [token, Buffer.from(token).toString("base64"), `prefix${token}suffix`]) {
			expect(parseOAuthTokenBlob(blob)).toMatchObject({ refresh: "refresh", access: "access", expires: 123 });
		}
		expect(parseV1Accounts("invalid")).toBeUndefined();
		expect(parseOAuthTokenBlob("invalid")).toBeUndefined();
	});

	it("imports only the fake HOME credential file and resolves its project", async () => {
		const directory = join(home, ".shuvpi", "agent");
		await mkdir(directory, { recursive: true });
		await writeFile(
			join(directory, "antigravity-accounts.json"),
			JSON.stringify({ accounts: [{ refreshToken: "imported-refresh|old-project" }] }),
		);
		const events: AuthEvent[] = [];
		const credential = await googleAntigravityOAuth.login({
			signal,
			prompt: async () => {
				throw new Error("Must import");
			},
			notify: (event) => events.push(event),
		});
		expect(credential.projectId).toBe("fake-project");
		expect(events).toEqual([{ type: "info", message: "Imported an existing Antigravity login." }]);
		expect(antigravityStatePaths().every((path) => path.startsWith(home))).toBe(true);
	});

	it("prefers fake IDE state over an account file", async () => {
		const statePath = join(home, "state.vscdb");
		await writeFile(
			statePath,
			`bytes-antigravityUnifiedStateSync.oauthToken${JSON.stringify({ refresh_token: "ide-refresh" })}`,
		);
		await writeFile(
			join(home, "antigravity-accounts.json"),
			JSON.stringify({ accounts: [{ refreshToken: "file-refresh" }] }),
		);
		expect(await importExisting({ statePaths: [statePath], dataDirs: [home] })).toMatchObject({
			refresh: "ide-refresh",
		});
	});

	it("retains a refresh token omitted by Google and preserves known project metadata", async () => {
		const fetchMock = fakeNetwork({ [TOKEN_URL]: { access_token: "new-access", expires_in: 120 } });
		vi.stubGlobal("fetch", fetchMock);
		const credential = await googleAntigravityOAuth.refresh(
			{
				type: "oauth",
				access: "old",
				refresh: "kept-refresh",
				expires: 0,
				projectId: "kept-project",
				email: "test@example.invalid",
				paidTier: "kept-tier",
			},
			signal,
		);
		expect(credential).toMatchObject({
			access: "new-access",
			refresh: "kept-refresh",
			projectId: "kept-project",
			paidTier: "kept-tier",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(new URLSearchParams(String(fetchMock.mock.calls[0]?.[1]?.body)).get("grant_type")).toBe("refresh_token");
	});

	it("discovers a missing project during refresh and refuses an absent project", async () => {
		const input = { type: "oauth" as const, access: "old", refresh: "refresh", expires: 0 };
		expect(await googleAntigravityOAuth.refresh(input, signal)).toMatchObject({ projectId: "fake-project" });
		vi.stubGlobal("fetch", fakeNetwork({ [ASSIST_URL]: {} }));
		await expect(googleAntigravityOAuth.refresh(input, signal)).rejects.toThrow("missing a Cloud Code project");
	});

	it("does not swallow cancellation while resolving an imported account", async () => {
		const controller = new AbortController();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				controller.abort();
				throw new Error("cancelled");
			}),
		);
		await expect(
			completeAccount(
				{ access: "access", refresh: "refresh", expires: Date.now() + 120_000, projectId: "stored-project" },
				controller.signal,
			),
		).rejects.toThrow();
	});

	it("validates token responses and exposes actionable Google errors", async () => {
		vi.stubGlobal("fetch", fakeNetwork({ [TOKEN_URL]: {} }));
		await expect(refreshTokens("refresh")).rejects.toThrow("invalid credential response");
		vi.stubGlobal("fetch", fakeNetwork({ [TOKEN_URL]: { access_token: "access" } }));
		await expect(exchangeAuthorizationCode("code", "verifier")).rejects.toThrow("no refresh token");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 })),
		);
		await expect(refreshTokens("refresh")).rejects.toThrow("invalid_grant");
	});
});
