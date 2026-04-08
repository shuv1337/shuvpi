import type { Api, Context, Model } from "../types.js";

const PROXX_PROVIDER_NAME = "proxx";
const LOG_PREFIX = "[ProxxDebug]";
const MAX_STRING_LENGTH = 4000;
const MAX_ARRAY_ITEMS = 40;
const MAX_OBJECT_DEPTH = 8;

function isSensitiveKey(key: string): boolean {
	const normalized = key.toLowerCase();
	return (
		normalized.includes("authorization") ||
		normalized.includes("api-key") ||
		normalized.includes("apikey") ||
		normalized.includes("token") ||
		normalized.includes("secret") ||
		normalized === "cookie" ||
		normalized.endsWith("_key")
	);
}

function redactString(value: string): string {
	if (value.length === 0) return "<redacted empty>";
	if (value.length <= 8) return `<redacted len=${value.length}>`;
	return `<redacted len=${value.length} suffix=${value.slice(-4)}>`;
}

function truncateString(value: string): string {
	if (value.length <= MAX_STRING_LENGTH) return value;
	return `${value.slice(0, MAX_STRING_LENGTH)}… <truncated ${value.length - MAX_STRING_LENGTH} chars>`;
}

function looksLikeDataUrl(value: string): boolean {
	return /^data:[^;]+;base64,/i.test(value);
}

function sanitizeUnknown(value: unknown, key?: string, depth = 0, seen = new WeakSet<object>()): unknown {
	if (key && isSensitiveKey(key)) {
		return typeof value === "string" ? redactString(value) : "<redacted>";
	}

	if (value == null || typeof value === "number" || typeof value === "boolean") {
		return value;
	}

	if (typeof value === "string") {
		if (looksLikeDataUrl(value)) {
			const mimeType = value.slice(5, value.indexOf(";base64,"));
			return `<data-url mime=${mimeType} len=${value.length}>`;
		}
		return truncateString(value);
	}

	if (typeof value === "bigint") {
		return value.toString();
	}

	if (typeof value === "function") {
		return `<function ${value.name || "anonymous"}>`;
	}

	if (value instanceof Error) {
		return {
			name: value.name,
			message: value.message,
			stack: truncateString(value.stack || ""),
		};
	}

	if (value instanceof URL) {
		return value.toString();
	}

	if (typeof Headers !== "undefined" && value instanceof Headers) {
		const result: Record<string, string> = {};
		for (const [headerKey, headerValue] of value.entries()) {
			result[headerKey] = isSensitiveKey(headerKey) ? redactString(headerValue) : truncateString(headerValue);
		}
		return result;
	}

	if (typeof value !== "object") {
		return String(value);
	}

	if (seen.has(value)) {
		return "<circular>";
	}
	seen.add(value);

	if (depth >= MAX_OBJECT_DEPTH) {
		return `<max-depth ${MAX_OBJECT_DEPTH}>`;
	}

	if (Array.isArray(value)) {
		const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeUnknown(item, undefined, depth + 1, seen));
		if (value.length > MAX_ARRAY_ITEMS) {
			items.push(`<${value.length - MAX_ARRAY_ITEMS} more items>`);
		}
		return items;
	}

	const result: Record<string, unknown> = {};
	for (const [entryKey, entryValue] of Object.entries(value)) {
		result[entryKey] = sanitizeUnknown(entryValue, entryKey, depth + 1, seen);
	}
	return result;
}

function parseRequestBody(body: unknown): unknown {
	if (typeof body !== "string") {
		if (body == null) return undefined;
		if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
			return body.toString();
		}
		return `<body type=${body.constructor?.name || typeof body}>`;
	}

	try {
		return sanitizeUnknown(JSON.parse(body));
	} catch {
		return sanitizeUnknown(body);
	}
}

function sanitizeHeaders(headers: unknown): Record<string, string> | undefined {
	if (!headers) return undefined;
	if (typeof Headers !== "undefined" && headers instanceof Headers) {
		return sanitizeUnknown(headers) as Record<string, string>;
	}
	if (Array.isArray(headers)) {
		const result: Record<string, string> = {};
		for (const [key, value] of headers) {
			result[key] = isSensitiveKey(key) ? redactString(value) : truncateString(value);
		}
		return result;
	}

	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		result[key] = isSensitiveKey(key) ? redactString(String(value)) : truncateString(String(value));
	}
	return result;
}

function logProxx(level: "log" | "warn" | "error", message: string, fields: Record<string, unknown>): void {
	const entry = JSON.stringify({
		ts: new Date().toISOString(),
		level,
		message,
		...fields,
	});
	if (level === "error") {
		console.error(LOG_PREFIX, entry);
		return;
	}
	if (level === "warn") {
		console.warn(LOG_PREFIX, entry);
		return;
	}
	console.log(LOG_PREFIX, entry);
}

export function isProxxModel(model: Model<Api>): boolean {
	return model.provider.trim().toLowerCase() === PROXX_PROVIDER_NAME;
}

export function logProxxStreamStart(model: Model<Api>, context: Context, options?: Record<string, unknown>): void {
	if (!isProxxModel(model)) return;
	logProxx("log", "starting upstream request", {
		provider: model.provider,
		api: model.api,
		model: model.id,
		baseUrl: model.baseUrl,
		reasoning: model.reasoning,
		messageCount: context.messages.length,
		toolCount: context.tools?.length || 0,
		hasSystemPrompt: Boolean(context.systemPrompt),
		options: sanitizeUnknown(options),
	});
}

export function logProxxStreamError(model: Model<Api>, error: unknown, extra?: Record<string, unknown>): void {
	if (!isProxxModel(model)) return;

	const maybeError = error as {
		status?: number;
		request_id?: string;
		error?: unknown;
		cause?: unknown;
	};

	logProxx("error", "upstream request failed", {
		provider: model.provider,
		api: model.api,
		model: model.id,
		baseUrl: model.baseUrl,
		status: maybeError?.status,
		requestId: maybeError?.request_id,
		error: sanitizeUnknown(error),
		providerError: sanitizeUnknown(maybeError?.error),
		cause: sanitizeUnknown(maybeError?.cause),
		extra: sanitizeUnknown(extra),
	});
}

export function createProxxLoggedFetch(model: Model<Api>): typeof fetch {
	const nativeFetch = globalThis.fetch.bind(globalThis);
	if (!isProxxModel(model)) {
		return nativeFetch;
	}

	return async (input: unknown, init?: RequestInit): Promise<Response> => {
		const startedAt = Date.now();
		const requestUrl =
			typeof input === "string" || input instanceof URL
				? input.toString()
				: typeof Request !== "undefined" && input instanceof Request
					? input.url
					: String(input);
		const requestMethod =
			init?.method || (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET");
		const requestHeaders =
			init?.headers || (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
		const requestBody = parseRequestBody(init?.body);

		logProxx("log", "http request", {
			provider: model.provider,
			api: model.api,
			model: model.id,
			baseUrl: model.baseUrl,
			url: requestUrl,
			method: requestMethod,
			headers: sanitizeHeaders(requestHeaders),
			body: requestBody,
		});

		try {
			const response = await nativeFetch(input as string | URL | Request, init);
			const durationMs = Date.now() - startedAt;
			const responseHeaders = sanitizeHeaders(response.headers);

			if (response.ok) {
				logProxx("log", "http response", {
					provider: model.provider,
					api: model.api,
					model: model.id,
					url: requestUrl,
					method: requestMethod,
					status: response.status,
					statusText: response.statusText,
					durationMs,
					contentType: response.headers.get("content-type") || undefined,
					headers: responseHeaders,
				});
				return response;
			}

			let responseBody: unknown;
			try {
				responseBody = parseRequestBody(await response.clone().text());
			} catch (error) {
				responseBody = {
					readError: sanitizeUnknown(error),
				};
			}

			logProxx("error", "http error response", {
				provider: model.provider,
				api: model.api,
				model: model.id,
				url: requestUrl,
				method: requestMethod,
				status: response.status,
				statusText: response.statusText,
				durationMs,
				headers: responseHeaders,
				body: responseBody,
			});
			return response;
		} catch (error) {
			logProxx("error", "http request threw", {
				provider: model.provider,
				api: model.api,
				model: model.id,
				url: requestUrl,
				method: requestMethod,
				durationMs: Date.now() - startedAt,
				error: sanitizeUnknown(error),
			});
			throw error;
		}
	};
}
