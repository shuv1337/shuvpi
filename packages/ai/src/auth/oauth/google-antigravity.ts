/**
 * Google AI Pro / Antigravity OAuth flow.
 *
 * Mints tokens with the official Antigravity CLI client, or imports an existing
 * Antigravity login when one is present, then resolves the Cloud Code project id
 * that every `v1internal` request needs.
 *
 * NOTE: This module uses Node.js filesystem and http APIs. It is only intended
 * for CLI use, not browser environments.
 */

import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import {
	type AccountInfo,
	antigravityUserAgent,
	loadCodeAssist,
	PROJECT_ID_HEADER,
} from "../../api/google-antigravity-shared.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";

/** Official Antigravity CLI client, extracted from `agy` 1.1.13. */
export const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
export const CALLBACK_PORT = 36742;
export const CALLBACK_PATH = "/oauth-callback";
export const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
export const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const USER_INFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

export const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
] as const;

export type Tokens = {
	access: string;
	refresh: string;
	expires: number;
};

export type ImportedAccount = {
	refresh: string;
	access?: string;
	expires?: number;
	projectId?: string;
	email?: string;
};

export type CompletedAccount = Tokens & {
	projectId: string;
	email?: string;
	paidTier?: string;
};

type NodeApis = {
	createServer: typeof import("node:http").createServer;
};

let nodeApis: NodeApis | null = null;
let nodeApisPromise: Promise<NodeApis> | null = null;

async function getNodeApis(): Promise<NodeApis> {
	if (nodeApis) return nodeApis;
	if (!nodeApisPromise) {
		if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
			throw new Error("Google AI Pro OAuth is only available in Node.js environments");
		}
		nodeApisPromise = import("node:http").then((httpModule) => ({ createServer: httpModule.createServer }));
	}
	nodeApis = await nodeApisPromise;
	return nodeApis;
}

export const authorizeURL = (challenge: string, state: string): string =>
	`${AUTHORIZE_URL}?${new URLSearchParams({
		response_type: "code",
		client_id: CLIENT_ID,
		redirect_uri: REDIRECT_URI,
		scope: SCOPES.join(" "),
		code_challenge: challenge,
		code_challenge_method: "S256",
		access_type: "offline",
		prompt: "consent",
		state,
	})}`;

/** Google omits `refresh_token` on refresh responses; the current one stays valid. */
export const nextRefresh = (current: string, returned?: string): string => returned || current;

const stringField = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
};

function parseJsonSafe(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

async function requestToken(body: URLSearchParams, currentRefresh?: string, signal?: AbortSignal): Promise<Tokens> {
	const timeout = AbortSignal.timeout(15_000);
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": antigravityUserAgent() },
		body: body.toString(),
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	// Google reports the actionable reason (invalid_grant, invalid_client) only in the body,
	// so a status-only message leaves the user with nothing to act on.
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(`Google OAuth failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
	}
	const data = asRecord(await response.json());
	const access = stringField(data?.access_token);
	if (!access) throw new Error("Google OAuth returned an invalid credential response");
	const refreshToken = nextRefresh(currentRefresh ?? "", stringField(data?.refresh_token));
	if (!refreshToken) throw new Error("Google OAuth returned no refresh token");
	const expiresIn = typeof data?.expires_in === "number" ? data.expires_in : 3600;
	return { access, refresh: refreshToken, expires: Date.now() + expiresIn * 1000 };
}

export const exchangeAuthorizationCode = (code: string, verifier: string, signal?: AbortSignal): Promise<Tokens> =>
	requestToken(
		new URLSearchParams({
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			redirect_uri: REDIRECT_URI,
		}),
		undefined,
		signal,
	);

export const refreshTokens = (refreshToken: string, signal?: AbortSignal): Promise<Tokens> =>
	requestToken(
		new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
		}),
		refreshToken,
		signal,
	);

export async function fetchUserInfo(access: string, signal?: AbortSignal): Promise<{ email?: string } | undefined> {
	const timeout = AbortSignal.timeout(15_000);
	const response = await fetch(USER_INFO_URL, {
		headers: { Authorization: `Bearer ${access}`, "User-Agent": antigravityUserAgent() },
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!response.ok) return undefined;
	return { email: stringField(asRecord(await response.json())?.email) };
}

/** V1 plugins stored the project id appended to the refresh token as `<refresh>|<project>`. */
export function splitRefresh(value: string): { refresh: string; projectId?: string } {
	const index = value.indexOf("|");
	if (index <= 0) return { refresh: value };
	return { refresh: value.slice(0, index), projectId: value.slice(index + 1) || undefined };
}

export function parseV1Accounts(text: string): ImportedAccount | undefined {
	const data = asRecord(parseJsonSafe(text));
	if (!data || !Array.isArray(data.accounts) || data.accounts.length === 0) return undefined;
	const index = typeof data.activeIndex === "number" && data.activeIndex >= 0 ? data.activeIndex : 0;
	const account = asRecord(data.accounts[index] ?? data.accounts[0]);
	const refreshToken = stringField(account?.refreshToken) ?? stringField(account?.refresh_token);
	if (!refreshToken) return undefined;
	const parts = splitRefresh(refreshToken);
	return {
		refresh: parts.refresh,
		projectId: stringField(account?.projectId) ?? stringField(account?.project_id) ?? parts.projectId,
		email: stringField(account?.email),
	};
}

function tokenFields(value: unknown): ImportedAccount | undefined {
	const data = asRecord(value);
	if (!data) return undefined;
	const refreshToken = stringField(data.refresh_token) ?? stringField(data.refreshToken) ?? stringField(data.refresh);
	if (!refreshToken) return undefined;
	const parts = splitRefresh(refreshToken);
	const expiresIn = typeof data.expires_in === "number" ? data.expires_in : undefined;
	const expiry =
		typeof data.expiry_date === "number"
			? data.expiry_date
			: typeof data.expires === "number"
				? data.expires
				: undefined;
	return {
		refresh: parts.refresh,
		access: stringField(data.access_token) ?? stringField(data.accessToken) ?? stringField(data.access),
		expires: expiry ?? (expiresIn ? Date.now() + expiresIn * 1000 : undefined),
		projectId: stringField(data.projectId) ?? stringField(data.project_id) ?? parts.projectId,
		email: stringField(data.email),
	};
}

/** The IDE stores its token as JSON, base64 JSON, or JSON embedded in a larger blob. */
export function parseOAuthTokenBlob(value: string): ImportedAccount | undefined {
	const direct = tokenFields(parseJsonSafe(value));
	if (direct) return direct;

	let decoded = "";
	try {
		decoded = Buffer.from(value, "base64").toString("utf8");
	} catch {
		decoded = "";
	}
	if (decoded) {
		const fromDecoded = tokenFields(parseJsonSafe(decoded));
		if (fromDecoded) return fromDecoded;
	}

	// Base64 decoding is lenient, so a non-base64 blob still yields bytes. Scan both
	// the decoded bytes and the original text for an embedded token object.
	for (const candidate of [decoded, value]) {
		for (const match of candidate.match(/\{[^{}]+\}/g) ?? []) {
			const found = tokenFields(parseJsonSafe(match));
			if (found) return found;
		}
	}
	return undefined;
}

export function antigravityStatePaths(home: string = os.homedir()): string[] {
	if (process.platform === "darwin") {
		return [path.join(home, "Library/Application Support/Antigravity/User/globalStorage/state.vscdb")];
	}
	if (process.platform === "win32") {
		return [
			path.join(
				process.env.APPDATA ?? path.join(home, "AppData/Roaming"),
				"Antigravity/User/globalStorage/state.vscdb",
			),
		];
	}
	return [
		path.join(
			process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"),
			"Antigravity/User/globalStorage/state.vscdb",
		),
	];
}

const VSCDB_TOKEN_KEY = "antigravityUnifiedStateSync.oauthToken";

/**
 * Reads the IDE token out of the VS Code state database. Node has no bundled
 * SQLite reader here, so the value is recovered from the raw page bytes; the
 * stored value is a JSON/base64 blob that `parseOAuthTokenBlob` understands.
 */
async function importFromVscdb(statePath: string): Promise<ImportedAccount | undefined> {
	const contents = await fs.readFile(statePath, "latin1");
	const index = contents.indexOf(VSCDB_TOKEN_KEY);
	if (index === -1) return undefined;
	return parseOAuthTokenBlob(contents.slice(index + VSCDB_TOKEN_KEY.length, index + VSCDB_TOKEN_KEY.length + 8192));
}

async function importFromAccountsFile(dataDir: string): Promise<ImportedAccount | undefined> {
	return parseV1Accounts(await fs.readFile(path.join(dataDir, "antigravity-accounts.json"), "utf8"));
}

/**
 * Tokens minted by the official client have a better standing than tokens minted
 * by a third-party client, so an existing login is always preferred over a fresh
 * authorization.
 */
export async function importExisting(options?: {
	dataDirs?: readonly string[];
	statePaths?: readonly string[];
}): Promise<ImportedAccount | undefined> {
	for (const statePath of options?.statePaths ?? antigravityStatePaths()) {
		const imported = await importFromVscdb(statePath).catch(() => undefined);
		if (imported) return imported;
	}
	for (const dataDir of options?.dataDirs ?? [path.join(os.homedir(), ".shuvpi", "agent")]) {
		const imported = await importFromAccountsFile(dataDir).catch(() => undefined);
		if (imported) return imported;
	}
	return undefined;
}

/** Turns tokens into a credential with a resolved Cloud Code project id. */
export async function completeAccount(
	input: ImportedAccount | Tokens,
	signal?: AbortSignal,
): Promise<CompletedAccount> {
	const access = "access" in input ? input.access : undefined;
	const expires = "expires" in input ? input.expires : undefined;
	const tokens =
		access && expires && expires > Date.now() + 60_000
			? { access, refresh: input.refresh, expires }
			: await refreshTokens(input.refresh, signal);
	const assist = await loadCodeAssist(tokens.access, signal).catch(() => ({}) as AccountInfo);
	const projectId = assist.projectId ?? ("projectId" in input ? input.projectId : undefined);
	if (!projectId) throw new Error("Google AI Pro did not return a Cloud Code project id");
	const email =
		("email" in input ? input.email : undefined) ??
		(await fetchUserInfo(tokens.access, signal).catch(() => undefined))?.email;
	return { ...tokens, projectId, email, paidTier: assist.paidTier };
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return { code: url.searchParams.get("code") ?? undefined, state: url.searchParams.get("state") ?? undefined };
	} catch {
		// not a URL
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
	}

	return { code: value };
}

type CallbackServerInfo = {
	server: Server;
	cancelWait: () => void;
	waitForCode: () => Promise<{ code: string; state: string } | null>;
};

async function startCallbackServer(expectedState: string): Promise<CallbackServerInfo> {
	const { createServer } = await getNodeApis();
	const host = getProviderEnvValue("SHUVPI_OAUTH_CALLBACK_HOST") || "127.0.0.1";

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
				const url = new URL(req.url || "", `http://localhost:${CALLBACK_PORT}`);
				if (url.pathname !== CALLBACK_PATH) {
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Callback route not found."));
					return;
				}

				const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
				if (error) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Google authentication did not complete.", `Error: ${error}`));
					return;
				}

				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
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
				res.end(oauthSuccessHtml("Google authentication completed. You can close this window."));
				settleWait?.({ code, state });
			} catch {
				res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("Internal error");
			}
		});

		server.on("error", (err) => reject(err));
		server.listen(CALLBACK_PORT, host, () => {
			resolve({
				server,
				cancelWait: () => settleWait?.(null),
				waitForCode: () => waitForCodePromise,
			});
		});
	});
}

function randomState(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function toCredential(account: CompletedAccount): OAuthCredential {
	return {
		type: "oauth",
		access: account.access,
		refresh: account.refresh,
		expires: account.expires,
		projectId: account.projectId,
		...(account.email ? { email: account.email } : {}),
		...(account.paidTier ? { paidTier: account.paidTier } : {}),
	};
}

async function loginGoogleAntigravity(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const imported = await importExisting().catch(() => undefined);
	if (imported) {
		const account = await completeAccount(imported, interaction.signal).catch(() => undefined);
		if (account) {
			interaction.notify({ type: "info", message: "Imported an existing Antigravity login." });
			return toCredential(account);
		}
	}

	const { verifier, challenge } = await generatePKCE();
	const state = randomState();
	const server = await startCallbackServer(state);
	const manualAbort = new AbortController();
	const onAbort = () => server.cancelWait();
	interaction.signal.addEventListener("abort", onAbort, { once: true });
	if (interaction.signal.aborted) onAbort();

	let code: string | undefined;
	let manualInput: string | undefined;
	let manualError: Error | undefined;

	try {
		interaction.notify({
			type: "auth_url",
			url: authorizeURL(challenge, state),
			instructions:
				"Complete authorization in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});

		const manualPromise = interaction
			.prompt({
				type: "manual_code",
				message: "Complete login in your browser, or paste the authorization code / redirect URL here:",
				placeholder: REDIRECT_URI,
				signal: manualAbort.signal,
			})
			.then((input) => {
				manualInput = input;
				server.cancelWait();
			})
			.catch((error) => {
				manualError = error instanceof Error ? error : new Error(String(error));
				server.cancelWait();
			});

		const readManualInput = () => {
			const parsed = parseAuthorizationInput(manualInput ?? "");
			if (parsed.state && parsed.state !== state) throw new Error("OAuth state mismatch");
			return parsed.code;
		};

		const result = await server.waitForCode();
		if (manualError) throw manualError;
		if (result?.code) code = result.code;
		else if (manualInput) code = readManualInput();

		if (!code) {
			await manualPromise;
			if (manualError) throw manualError;
			if (manualInput) code = readManualInput();
		}
		if (!code) throw new Error("Missing authorization code");

		interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
		const tokens = await exchangeAuthorizationCode(code, verifier, interaction.signal);
		interaction.notify({ type: "progress", message: "Resolving Google AI Pro account..." });
		return toCredential(await completeAccount(tokens, interaction.signal));
	} finally {
		interaction.signal.removeEventListener("abort", onAbort);
		manualAbort.abort();
		server.server.close();
	}
}

async function refreshGoogleAntigravity(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
	const tokens = await refreshTokens(credential.refresh, signal);
	const storedProjectId = stringField(credential.projectId);
	// Re-derive the project id only when the credential predates it; the extra
	// Cloud Code round trip on every refresh is not worth paying otherwise.
	const projectId =
		storedProjectId ?? (await loadCodeAssist(tokens.access, signal).catch(() => ({}) as AccountInfo)).projectId;
	if (!projectId) throw new Error("Google AI Pro is missing a Cloud Code project id. Log in again.");
	return {
		type: "oauth",
		access: tokens.access,
		refresh: tokens.refresh,
		expires: tokens.expires,
		projectId,
		...(stringField(credential.email) ? { email: credential.email } : {}),
		...(stringField(credential.paidTier) ? { paidTier: credential.paidTier } : {}),
	};
}

export const googleAntigravityOAuth: OAuthAuth = {
	name: "Google AI Pro / Antigravity",
	isSubscription: true,
	loginLabel: "Sign in with Google AI Pro / Antigravity",
	login: loginGoogleAntigravity,
	refresh: refreshGoogleAntigravity,

	async toAuth(credential) {
		const projectId = stringField(credential.projectId);
		return {
			apiKey: credential.access,
			...(projectId ? { headers: { [PROJECT_ID_HEADER]: projectId } } : {}),
		};
	},
};
