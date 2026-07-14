/**
 * xAI OAuth (SuperGrok / Grok CLI) — PKCE loopback flow aligned with Hermes hermes_cli/auth.py.
 *
 * Inference: https://api.x.ai/v1/responses (openai-codex-responses transport).
 */

import type { Server } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

export const XAI_OAUTH_DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const DEFAULT_XAI_OAUTH_BASE_URL = "https://api.x.ai/v1";

const CALLBACK_HOST = process.env.SHUVPI_XAI_OAUTH_CALLBACK_HOST || process.env.XAI_OAUTH_REDIRECT_HOST || "127.0.0.1";
const CALLBACK_PORT = Number(
	process.env.SHUVPI_XAI_OAUTH_CALLBACK_PORT || process.env.XAI_OAUTH_REDIRECT_PORT || "56121",
);
const CALLBACK_PATH = process.env.XAI_OAUTH_REDIRECT_PATH || "/callback";
const REDIRECT_URI = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;

// Defer the node:http dependency to call time so importing this module (and the public
// `@shuv1337/shuvpi-ai/oauth` barrel that re-exports it) stays load-safe in browser/edge/Workers
// runtimes. Mirrors the lazy + environment-guard pattern in anthropic.ts and the other providers.
type NodeApis = {
	createServer: typeof import("node:http").createServer;
};

let nodeApis: NodeApis | null = null;
let nodeApisPromise: Promise<NodeApis> | null = null;

async function getNodeApis(): Promise<NodeApis> {
	if (nodeApis) return nodeApis;
	if (!nodeApisPromise) {
		if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
			throw new Error("xAI OAuth is only available in Node.js environments");
		}
		nodeApisPromise = import("node:http").then((httpModule) => ({
			createServer: httpModule.createServer,
		}));
	}
	nodeApis = await nodeApisPromise;
	return nodeApis;
}

type Discovery = {
	authorization_endpoint: string;
	token_endpoint: string;
};

function randomHex(bytes = 16): string {
	const arr = new Uint8Array(bytes);
	crypto.getRandomValues(arr);
	return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function fetchXaiOAuthDiscovery(): Promise<Discovery> {
	const response = await fetch(XAI_OAUTH_DISCOVERY_URL, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(20_000),
	});
	if (!response.ok) {
		throw new Error(`xAI OIDC discovery failed (HTTP ${response.status})`);
	}
	const json = (await response.json()) as Record<string, unknown>;
	const authorization_endpoint = String(json.authorization_endpoint || "").trim();
	const token_endpoint = String(json.token_endpoint || "").trim();
	if (!authorization_endpoint || !token_endpoint) {
		throw new Error("xAI OIDC discovery missing authorization_endpoint or token_endpoint");
	}
	if (!token_endpoint.includes("auth.x.ai")) {
		throw new Error(`xAI token_endpoint must be on auth.x.ai (got ${token_endpoint})`);
	}
	return { authorization_endpoint, token_endpoint };
}

function parseAuthorizationInput(input: string): { code?: string; state?: string; manualPaste?: boolean } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
			manualPaste: true,
		};
	} catch {
		// not a URL
	}

	if (value.includes("code=")) {
		const query = value.includes("?") ? value.slice(value.indexOf("?")) : `?${value}`;
		const params = new URLSearchParams(query);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
			manualPaste: true,
		};
	}

	return { code: value, manualPaste: true };
}

function buildAuthorizeUrl(params: {
	authorizationEndpoint: string;
	redirectUri: string;
	codeChallenge: string;
	state: string;
	nonce: string;
}): string {
	const url = new URL(params.authorizationEndpoint);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", XAI_OAUTH_CLIENT_ID);
	url.searchParams.set("redirect_uri", params.redirectUri);
	url.searchParams.set("scope", XAI_OAUTH_SCOPE);
	url.searchParams.set("code_challenge", params.codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", params.state);
	url.searchParams.set("nonce", params.nonce);
	url.searchParams.set("plan", "generic");
	url.searchParams.set("referrer", "shuvpi");
	return url.toString();
}

function truncateErrorBody(text: string, max = 500): string {
	const trimmed = (text || "").trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max)}… (truncated)`;
}

async function postFormToken(tokenEndpoint: string, data: Record<string, string>): Promise<Record<string, unknown>> {
	const body = new URLSearchParams(data);
	const response = await fetch(tokenEndpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body,
		signal: AbortSignal.timeout(30_000),
	});
	const text = await response.text();
	if (!response.ok) {
		// Bound the echoed response body. It is the server's error payload (not our submitted
		// secrets), but the token endpoint is not under our control — cap it so a large or
		// credential-reflecting body can't bloat or leak through logs.
		const detail = truncateErrorBody(text);
		if (response.status === 403) {
			throw new Error(
				`xAI token request failed (HTTP 403).${detail ? ` ${detail}` : ""} This OAuth account may not be authorized for API access — try XAI_API_KEY with provider xai, or upgrade at https://x.ai/grok.`,
			);
		}
		throw new Error(`xAI token request failed (HTTP ${response.status}).${detail ? ` ${detail}` : ""}`);
	}
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		throw new Error(`xAI token response was not valid JSON: ${truncateErrorBody(text)}`);
	}
}

export async function exchangeXaiAuthorizationCode(params: {
	tokenEndpoint: string;
	code: string;
	redirectUri: string;
	codeVerifier: string;
	codeChallenge: string;
}): Promise<Record<string, unknown>> {
	if (!params.codeVerifier) {
		throw new Error("xAI token exchange refused: PKCE code_verifier is empty");
	}
	const data: Record<string, string> = {
		grant_type: "authorization_code",
		code: params.code,
		redirect_uri: params.redirectUri,
		client_id: XAI_OAUTH_CLIENT_ID,
		code_verifier: params.codeVerifier,
	};
	if (params.codeChallenge) {
		data.code_challenge = params.codeChallenge;
		data.code_challenge_method = "S256";
	}
	return postFormToken(params.tokenEndpoint, data);
}

function credentialsFromTokenPayload(
	payload: Record<string, unknown>,
	discovery: Discovery,
	redirectUri: string,
	refreshFallback?: string,
): OAuthCredentials {
	const access = String(payload.access_token || "").trim();
	const refresh = String(payload.refresh_token || refreshFallback || "").trim();
	if (!access) throw new Error("xAI token exchange did not return access_token");
	if (!refresh) throw new Error("xAI token exchange did not return refresh_token");
	const expiresIn = Number(payload.expires_in ?? 3600);
	return {
		access,
		refresh,
		expires: Date.now() + Math.max(60, expiresIn) * 1000,
		token_endpoint: discovery.token_endpoint,
		authorization_endpoint: discovery.authorization_endpoint,
		redirect_uri: redirectUri,
		id_token: payload.id_token,
	};
}

type CallbackServerInfo = {
	server: Server;
	redirectUri: string;
	cancelWait: () => void;
	waitForCode: () => Promise<{ code: string; state: string } | null>;
};

async function startCallbackServer(expectedState: string): Promise<CallbackServerInfo> {
	const { createServer } = await getNodeApis();
	return new Promise((resolve, reject) => {
		let settleWait: ((value: { code: string; state: string } | null) => void) | undefined;
		const waitForCodePromise = new Promise<{ code: string; state: string } | null>((resolveWait) => {
			let settled = false;
			settleWait = (value) => {
				if (settled) return;
				settled = true;
				resolveWait(value);
			};
		});

		const server = createServer((req, res) => {
			try {
				const url = new URL(req.url || "", `http://${CALLBACK_HOST}`);
				if (url.pathname !== CALLBACK_PATH) {
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Callback route not found."));
					return;
				}

				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");

				if (error) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("xAI authentication did not complete.", `Error: ${error}`));
					return;
				}

				if (!code || !state) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Missing code or state parameter."));
					return;
				}

				if (state !== expectedState) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("State mismatch."));
					return;
				}

				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthSuccessHtml("xAI authentication completed. You can close this window."));
				settleWait?.({ code, state });
			} catch {
				res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("Internal error");
			}
		});

		server.on("error", (err) => {
			if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
				reject(
					new Error(
						`xAI OAuth callback port ${CALLBACK_PORT} on ${CALLBACK_HOST} is already in use. ` +
							`Close the process using it, or set SHUVPI_XAI_OAUTH_CALLBACK_PORT to a free port and retry.`,
					),
				);
				return;
			}
			reject(err);
		});

		server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
			resolve({
				server,
				redirectUri: REDIRECT_URI,
				cancelWait: () => settleWait?.(null),
				waitForCode: () => waitForCodePromise,
			});
		});
	});
}

export async function refreshXaiOAuthToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const refresh = credentials.refresh?.trim();
	if (!refresh) {
		throw new Error("xAI OAuth is missing refresh_token. Re-login with /login xai-oauth.");
	}
	let tokenEndpoint = String(credentials.token_endpoint || "").trim();
	if (!tokenEndpoint) {
		tokenEndpoint = (await fetchXaiOAuthDiscovery()).token_endpoint;
	}
	const payload = await postFormToken(tokenEndpoint, {
		grant_type: "refresh_token",
		client_id: XAI_OAUTH_CLIENT_ID,
		refresh_token: refresh,
	});
	const discovery: Discovery = {
		authorization_endpoint: String(credentials.authorization_endpoint || ""),
		token_endpoint: tokenEndpoint,
	};
	const redirectUri = String(credentials.redirect_uri || REDIRECT_URI);
	return credentialsFromTokenPayload(payload, discovery, redirectUri, refresh);
}

export async function loginXaiOAuth(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const discovery = await fetchXaiOAuthDiscovery();
	const { verifier, challenge } = await generatePKCE();
	const state = randomHex();
	const nonce = randomHex();
	const redirectUri = REDIRECT_URI;

	const authorizeUrl = buildAuthorizeUrl({
		authorizationEndpoint: discovery.authorization_endpoint,
		redirectUri,
		codeChallenge: challenge,
		state,
		nonce,
	});

	callbacks.onAuth({
		url: authorizeUrl,
		instructions: `Waiting for callback on ${redirectUri}. On a remote host, paste the full callback URL or authorization code when prompted.`,
	});

	const { server, waitForCode, cancelWait } = await startCallbackServer(state);
	let code: string | undefined;

	try {
		if (callbacks.onManualCodeInput) {
			let manualCode: string | undefined;
			let manualError: Error | undefined;
			const manualPromise = callbacks
				.onManualCodeInput()
				.then((input) => {
					manualCode = input;
					cancelWait();
				})
				.catch((err) => {
					manualError = err instanceof Error ? err : new Error(String(err));
					cancelWait();
				});

			callbacks.signal?.throwIfAborted();
			const result = await waitForCode();

			if (manualError) {
				throw manualError;
			}

			if (result?.code) {
				code = result.code;
			} else if (manualCode) {
				const parsed = parseAuthorizationInput(manualCode);
				if (parsed.state && parsed.state !== state) {
					throw new Error(
						"xAI authorization failed: state mismatch. Paste the callback URL from this login attempt only (or paste the bare code from the xAI page).",
					);
				}
				code = parsed.code;
			}

			if (!code) {
				await manualPromise;
				if (manualError) {
					throw manualError;
				}
				if (manualCode) {
					const parsed = parseAuthorizationInput(manualCode);
					if (parsed.state && parsed.state !== state) {
						throw new Error(
							"xAI authorization failed: state mismatch. Paste the callback URL from this login attempt only (or paste the bare code from the xAI page).",
						);
					}
					code = parsed.code;
				}
			}
		} else {
			const waitMs = 270_000;
			const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs));
			const result = await Promise.race([waitForCode(), timeout]);
			if (result?.code) {
				code = result.code;
			} else {
				throw new Error("xAI authorization timed out. Use manual code input on remote sessions.");
			}
		}
	} finally {
		server.close();
	}

	if (!code) {
		throw new Error("xAI authorization failed: missing authorization code");
	}

	const payload = await exchangeXaiAuthorizationCode({
		tokenEndpoint: discovery.token_endpoint,
		code,
		redirectUri,
		codeVerifier: verifier,
		codeChallenge: challenge,
	});

	return credentialsFromTokenPayload(payload, discovery, redirectUri);
}

export const xaiOAuthProvider: OAuthProviderInterface = {
	id: "xai-oauth",
	name: "xAI SuperGrok (OAuth)",
	usesCallbackServer: true,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginXaiOAuth(callbacks);
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshXaiOAuthToken(credentials);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};
