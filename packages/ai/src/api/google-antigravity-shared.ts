/**
 * Google AI Pro / Antigravity wire helpers.
 *
 * Pure, runtime-neutral: no Node built-ins, so the OAuth flow (Node only), the
 * stream implementation, and the provider definition can all share it.
 *
 * The Antigravity CLI talks to Cloud Code's `v1internal:streamGenerateContent`
 * with a native Gemini body wrapped in a project/labels envelope, and replies
 * with SSE frames whose payload is `{ response: <native Gemini chunk> }`.
 */

import type { Model } from "../types.ts";
import { uuidv7 } from "../utils/uuid.ts";

export const CLOUD_CODE_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const GENERATE_URL = `${CLOUD_CODE_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`;
export const DEFAULT_MODEL_ID = "gemini-3.7-flash-high";

/**
 * Antigravity model metadata is absent from models.dev, so limits are pinned here.
 * Cloud Code validates `maxOutputTokens` against the model and answers 400
 * INVALID_ARGUMENT when it is too high: the Pro agent rejects Flash's 65536.
 */
const CONTEXT_WINDOW = 1_048_576;
const FLASH_MAX_OUTPUT = 65_536;
const PRO_MAX_OUTPUT = 32_768;

const CLI_VERSION = "1.1.15";
const CLI_CL = "966910857";

/** Header carrying the Cloud Code project id from the stored OAuth credential to the stream. */
export const PROJECT_ID_HEADER = "x-goog-antigravity-project";

export type CatalogModel = {
	id: string;
	name?: string;
	modelEnum?: string;
	provider?: string;
	internal?: boolean;
	recommended?: boolean;
};

export type AccountInfo = {
	projectId?: string;
	email?: string;
	paidTier?: string;
};

export type ShippedModel = {
	id: string;
	name: string;
	/** Catalog id sent on the wire when it differs from the selectable id. */
	apiID?: string;
	modelEnum?: string;
	maxOutput?: number;
};

export const SHIPPED_MODELS: readonly ShippedModel[] = [
	{ id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)", modelEnum: "MODEL_PLACEHOLDER_M298" },
	{ id: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)", modelEnum: "MODEL_PLACEHOLDER_M299" },
	{ id: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)", modelEnum: "MODEL_PLACEHOLDER_M300" },
	{ id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)" },
	{ id: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)" },
	{ id: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)" },
	{ id: "gemini-3-flash-agent", name: "Gemini 3.5 Flash (High)" },
	{ id: "gemini-3.5-flash-low", name: "Gemini 3.5 Flash (Medium)" },
	{ id: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)", maxOutput: PRO_MAX_OUTPUT },
	{
		id: "gemini-3.1-pro-high",
		name: "Gemini 3.1 Pro (High)",
		apiID: "gemini-pro-agent",
		maxOutput: PRO_MAX_OUTPUT,
	},
	{ id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)", maxOutput: PRO_MAX_OUTPUT },
];

/** Pro agents cap output below Flash; discovered ids carry no limit metadata. */
export const maxOutputFor = (id: string): number =>
	/(^|-)pro(-|$)|pro-agent/.test(id.toLowerCase()) ? PRO_MAX_OUTPUT : FLASH_MAX_OUTPUT;

export const SHIPPED_MODEL_IDS: ReadonlySet<string> = new Set(SHIPPED_MODELS.map((model) => model.id));

const ALIASES: Readonly<Record<string, string>> = { "gemini-3.1-pro-high": "gemini-pro-agent" };

export const MODEL_ENUM_DEFAULTS: ReadonlyMap<string, string> = new Map(
	SHIPPED_MODELS.flatMap((model) => (model.modelEnum ? [[model.id, model.modelEnum] as const] : [])),
);

/** Wire catalog id for a selectable model id. */
export const catalogModelId = (id: string): string => ALIASES[id] ?? id;

const osType = (): string => {
	if (typeof process === "undefined") return "linux";
	if (process.platform === "darwin") return "darwin";
	if (process.platform === "win32") return "windows";
	return "linux";
};

const archType = (): string => (typeof process !== "undefined" && process.arch === "arm64" ? "arm64" : "amd64");

/** The official Antigravity CLI user agent. Impersonating the Electron IDE instead gets flagged. */
export const antigravityUserAgent = (): string =>
	`antigravity/cli/${CLI_VERSION} (aidev_client; os_type=${osType()}; arch=${archType()}; cl=${CLI_CL}; auth_method=consumer)`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

function parseJsonSafe(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * Claude and GPT models share a separate Cloud Code quota bucket ("3p-weekly"/"3p-5h").
 * Serving them is what got comparable projects banned, so they never reach the catalog.
 */
export function isBlockedModelId(id: string): boolean {
	const lower = id.toLowerCase();
	if (lower.startsWith("claude") || lower.startsWith("gpt") || lower.includes("gpt-oss")) return true;
	if (lower.startsWith("tab_") || lower.startsWith("chat_")) return true;
	if (lower.includes("image")) return true;
	return false;
}

export function isGoogleCatalogModel(model: CatalogModel): boolean {
	if (model.internal) return false;
	if (isBlockedModelId(model.id)) return false;
	if (model.provider && model.provider !== "MODEL_PROVIDER_GOOGLE") return false;
	return true;
}

export function filterGoogleModels(models: readonly CatalogModel[]): CatalogModel[] {
	return models.filter(isGoogleCatalogModel);
}

export function modelEnumsFrom(models: readonly CatalogModel[]): Map<string, string> {
	const next = new Map(MODEL_ENUM_DEFAULTS);
	for (const model of models) {
		if (model.modelEnum) next.set(model.id, model.modelEnum);
	}
	return next;
}

export function parseCatalogModels(payload: unknown): CatalogModel[] {
	const data = isRecord(payload) ? payload : undefined;
	const list = [data?.models, data?.availableModels, data?.model].find(Array.isArray);
	if (!list) return [];
	return list.flatMap((item) => {
		const model = isRecord(item) ? item : undefined;
		if (!model) return [];
		const id = stringField(model.id) ?? stringField(model.name) ?? stringField(model.modelId);
		if (!id) return [];
		return [
			{
				id,
				name: stringField(model.displayName) ?? stringField(model.display_name) ?? stringField(model.name),
				modelEnum: stringField(model.model) ?? stringField(model.model_enum) ?? stringField(model.modelEnum),
				provider: stringField(model.modelProvider) ?? stringField(model.model_provider),
				internal: model.isInternal === true || model.is_internal === true,
				recommended: model.recommended === true,
			},
		];
	});
}

async function cloudCode<T>(endpointPath: string, access: string, body: unknown, signal?: AbortSignal): Promise<T> {
	const timeout = AbortSignal.timeout(15_000);
	const response = await fetch(`${CLOUD_CODE_ENDPOINT}${endpointPath}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${access}`,
			"Content-Type": "application/json",
			"User-Agent": antigravityUserAgent(),
		},
		body: JSON.stringify(body),
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!response.ok) throw new Error(`Cloud Code ${endpointPath} failed with HTTP ${response.status}`);
	return (await response.json()) as T;
}

/** Resolves the Cloud Code project id and paid tier for an account. */
export async function loadCodeAssist(access: string, signal?: AbortSignal): Promise<AccountInfo> {
	const payload = await cloudCode<unknown>(
		"/v1internal:loadCodeAssist",
		access,
		{ metadata: { ideType: "ANTIGRAVITY" } },
		signal,
	);
	const data = isRecord(payload) ? payload : undefined;
	if (!data) return {};
	const project = data.cloudaicompanionProject;
	const projectRecord = isRecord(project) ? project : undefined;
	const paid = data.paidTier;
	const paidRecord = isRecord(paid) ? paid : undefined;
	return {
		projectId: stringField(project) ?? stringField(projectRecord?.id) ?? stringField(projectRecord?.name),
		paidTier: stringField(paid) ?? stringField(paidRecord?.id) ?? stringField(paidRecord?.name),
	};
}

export async function fetchAvailableModels(
	access: string,
	project: string,
	signal?: AbortSignal,
): Promise<CatalogModel[]> {
	return parseCatalogModels(await cloudCode<unknown>("/v1internal:fetchAvailableModels", access, { project }, signal));
}

/**
 * Strips JSON Schema keywords Cloud Code rejects. Known limitation: a `$ref` is
 * dropped rather than resolved, so a tool parameter defined only by reference
 * degrades to untyped.
 */
export function cleanSchema(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(cleanSchema);
	if (!isRecord(value)) return value;
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		if (key === "$ref" || key === "$defs" || key === "$schema" || key === "default") continue;
		if (key === "const") {
			result.enum = [cleanSchema(value[key])];
			continue;
		}
		result[key] = cleanSchema(value[key]);
	}
	return result;
}

function cleanTool(tool: unknown): unknown {
	if (!isRecord(tool) || !Array.isArray(tool.functionDeclarations)) return tool;
	return {
		...tool,
		functionDeclarations: tool.functionDeclarations.map((declaration) => {
			if (!isRecord(declaration) || !("parameters" in declaration)) return declaration;
			return { ...declaration, parameters: cleanSchema(declaration.parameters) };
		}),
	};
}

/** Cloud Code rejects a system instruction without a role; the CLI always sends `user`. */
function withSystemRole(systemInstruction: unknown): unknown {
	if (!isRecord(systemInstruction)) return systemInstruction;
	return { role: "user", ...systemInstruction };
}

/**
 * Deterministic unsigned 64-bit session number. Cloud Code only uses it to group
 * requests, so a stable pure hash avoids pulling `node:crypto` into this module.
 */
function sessionNumber(sessionID: string): string {
	let hash = 0xcbf29ce484222325n;
	const prime = 0x100000001b3n;
	const mask = 0xffffffffffffffffn;
	for (let i = 0; i < sessionID.length; i++) {
		hash = ((hash ^ BigInt(sessionID.charCodeAt(i))) * prime) & mask;
	}
	return hash.toString();
}

function safeSession(sessionID: string): string {
	return sessionID.replace(/[^a-zA-Z0-9_-]/g, "") || "session";
}

/** Wraps a native Gemini request body in the Cloud Code agent envelope. */
export function wrapGenerateRequest(input: {
	body: unknown;
	projectId: string;
	model: string;
	sessionID: string;
	modelEnum?: string;
	now?: number;
	trajectory?: string;
}): unknown {
	// Already wrapped (an extension or a replayed payload).
	if (isRecord(input.body) && isRecord(input.body.request) && typeof input.body.project === "string")
		return input.body;
	const native = isRecord(input.body) ? input.body : {};
	const tools = Array.isArray(native.tools) ? native.tools.map(cleanTool) : undefined;
	const trajectory = input.trajectory ?? uuidv7();
	const now = input.now ?? Date.now();
	const generationConfig = isRecord(native.generationConfig) ? { ...native.generationConfig } : undefined;
	if (generationConfig && isRecord(generationConfig.thinkingConfig)) {
		generationConfig.thinkingConfig = { includeThoughts: true, ...generationConfig.thinkingConfig };
	}
	return {
		project: input.projectId,
		requestId: `agent/${safeSession(input.sessionID)}/${now}/${trajectory}/2`,
		model: catalogModelId(input.model),
		userAgent: "antigravity",
		requestType: "agent",
		request: {
			...native,
			...(native.systemInstruction ? { systemInstruction: withSystemRole(native.systemInstruction) } : {}),
			...(tools ? { tools } : {}),
			...(tools && tools.length > 0 ? { toolConfig: { functionCallingConfig: { mode: "VALIDATED" } } } : {}),
			...(generationConfig ? { generationConfig } : {}),
			labels: {
				last_step_index: "1",
				...(input.modelEnum ? { model_enum: input.modelEnum } : {}),
				request_id: `${trajectory}-0`,
				trajectory_id: trajectory,
				used_claude: "false",
				used_claude_conservative: "false",
				used_non_gemini_model: "false",
			},
			sessionId: sessionNumber(input.sessionID),
		},
	};
}

/** Unwraps one `data:` SSE line from the Cloud Code envelope into a native Gemini chunk. */
export function unwrapDataLine(line: string): string {
	if (!line.startsWith("data:")) return line;
	const payload = line.slice(5).trim();
	if (!payload || payload === "[DONE]") return line;
	const parsed = parseJsonSafe(payload);
	if (!isRecord(parsed) || !("response" in parsed)) return line;
	return `data: ${JSON.stringify(parsed.response)}`;
}

export function unwrapSSEText(text: string): string {
	return text
		.split(/\r?\n/)
		.map((line) => (line.startsWith("data:") ? unwrapDataLine(line) : line))
		.join("\n");
}

/** Builds the selectable model catalog: shipped ids first, then discovered Google ids. */
export function buildAntigravityModels(
	providerId: string,
	discovered?: readonly CatalogModel[],
): readonly Model<"google-antigravity">[] {
	const models: Model<"google-antigravity">[] = [];
	const seen = new Set<string>();

	const push = (id: string, name: string, maxOutput: number) => {
		if (seen.has(id)) return;
		seen.add(id);
		models.push({
			id,
			name,
			api: "google-antigravity",
			provider: providerId,
			baseUrl: CLOUD_CODE_ENDPOINT,
			reasoning: true,
			input: ["text", "image"],
			// Subscription access: usage is quota-metered, not billed per token.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: CONTEXT_WINDOW,
			maxTokens: maxOutput,
		});
	};

	for (const shipped of SHIPPED_MODELS) push(shipped.id, shipped.name, shipped.maxOutput ?? FLASH_MAX_OUTPUT);
	for (const item of filterGoogleModels(discovered ?? [])) {
		push(item.id, item.name ?? item.id, maxOutputFor(item.id));
	}

	return models;
}
