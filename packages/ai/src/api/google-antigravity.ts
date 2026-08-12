/**
 * Google AI Pro / Antigravity stream implementation.
 *
 * Builds a native Gemini request, wraps it in the Cloud Code `v1internal`
 * envelope, and unwraps the `{ response: ... }` SSE frames back into the
 * regular Gemini chunk shape before parsing.
 */

import type { Content, ThinkingConfig } from "@google/genai";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import {
	antigravityUserAgent,
	catalogModelId,
	GENERATE_URL,
	loadCodeAssist,
	MODEL_ENUM_DEFAULTS,
	PROJECT_ID_HEADER,
	unwrapDataLine,
	wrapGenerateRequest,
} from "./google-antigravity-shared.ts";
import type { GoogleThinkingLevel } from "./google-shared.ts";
import {
	convertMessages,
	convertTools,
	isThinkingPart,
	mapStopReasonString,
	resolveGoogleFunctionCallingMode,
	retainThoughtSignature,
	supportsGoogleStrictToolSampling,
} from "./google-shared.ts";
import { adjustMaxTokensForThinking, buildBaseOptions } from "./simple-options.ts";

export interface GoogleAntigravityOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		/**
		 * Thinking budget in tokens. This is what Cloud Code accepts; prefer it
		 * over `level`.
		 */
		budgetTokens?: number;
		/**
		 * Gemini API thinking level. Cloud Code accepts it, but the official
		 * Antigravity CLI sends a budget, so `streamSimple` uses `budgetTokens`
		 * and this stays available for callers that want a level.
		 */
		level?: GoogleThinkingLevel;
	};
	/** Cloud Code project id. Normally supplied through the credential-derived header. */
	projectId?: string;
}

type AntigravityChunk = {
	candidates?: Array<{
		content?: {
			role?: string;
			parts?: Array<{
				text?: string;
				thought?: boolean;
				thoughtSignature?: string;
				functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
			}>;
		};
		finishReason?: string;
	}>;
	usageMetadata?: {
		promptTokenCount?: number;
		candidatesTokenCount?: number;
		thoughtsTokenCount?: number;
		totalTokenCount?: number;
		cachedContentTokenCount?: number;
	};
	responseId?: string;
};

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

/**
 * Cloud Code reports the actionable reason inside the JSON body — quota resets,
 * invalid arguments — so surface that instead of the raw envelope.
 */
function extractErrorMessage(errorText: string): string {
	try {
		const parsed = JSON.parse(errorText) as { error?: { message?: string; status?: string } };
		const message = parsed.error?.message;
		if (message) {
			const status = parsed.error?.status;
			return status && !message.includes(status) ? `${message} (${status})` : message;
		}
	} catch {
		// Not JSON, fall through to the raw text.
	}
	return errorText.slice(0, 500);
}

function resolveProjectId(options: GoogleAntigravityOptions | undefined): string | undefined {
	if (options?.projectId) return options.projectId;
	const headers = providerHeadersToRecord(options?.headers);
	if (!headers) return undefined;
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() === PROJECT_ID_HEADER && value) return value;
	}
	return undefined;
}

function buildNativeBody(
	model: Model<"google-antigravity">,
	context: Context,
	options: GoogleAntigravityOptions | undefined,
): Record<string, unknown> {
	const contents: Content[] = convertMessages(model, context);

	const generationConfig: Record<string, unknown> = {};
	if (options?.temperature !== undefined) generationConfig.temperature = options.temperature;
	if (options?.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens;
	if (options?.thinking?.enabled) {
		const thinkingConfig: ThinkingConfig = { includeThoughts: true };
		if (options.thinking.level !== undefined) {
			thinkingConfig.thinkingLevel = options.thinking.level as ThinkingConfig["thinkingLevel"];
		} else if (options.thinking.budgetTokens !== undefined) {
			thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
		generationConfig.thinkingConfig = thinkingConfig;
	}

	const functionCallingMode = context.tools?.length
		? resolveGoogleFunctionCallingMode(context.tools, options?.toolChoice, supportsGoogleStrictToolSampling(model.id))
		: undefined;

	return {
		contents,
		...(context.systemPrompt
			? { systemInstruction: { parts: [{ text: sanitizeSurrogates(context.systemPrompt) }] } }
			: {}),
		...(context.tools && context.tools.length > 0 ? { tools: convertTools(context.tools) } : {}),
		...(functionCallingMode !== undefined
			? { toolConfig: { functionCallingConfig: { mode: functionCallingMode } } }
			: {}),
		...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
	};
}

export const stream: StreamFunction<"google-antigravity", GoogleAntigravityOptions> = (
	model: Model<"google-antigravity">,
	context: Context,
	options?: GoogleAntigravityOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-antigravity" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			const accessToken = options?.apiKey;
			if (!accessToken) {
				throw new Error("Google AI Pro requires OAuth authentication. Use /login to authenticate.");
			}

			// The project id normally rides the credential-derived header. Re-deriving it from
			// Cloud Code keeps a credential stored before this field existed usable.
			const projectId = resolveProjectId(options) ?? (await loadCodeAssist(accessToken, options?.signal)).projectId;
			if (!projectId) {
				throw new Error("Google AI Pro is missing a Cloud Code project id. Use /login to re-authenticate.");
			}

			let requestBody = wrapGenerateRequest({
				body: buildNativeBody(model, context, options),
				projectId,
				model: model.id,
				sessionID: options?.sessionId ?? "session",
				modelEnum: MODEL_ENUM_DEFAULTS.get(model.id) ?? MODEL_ENUM_DEFAULTS.get(catalogModelId(model.id)),
			});
			const nextRequestBody = await options?.onPayload?.(requestBody, model);
			if (nextRequestBody !== undefined) requestBody = nextRequestBody;

			const requestHeaders: Record<string, string> = {
				...providerHeadersToRecord(options?.headers),
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				"User-Agent": antigravityUserAgent(),
			};
			// A Gemini API key header would authenticate the wrong client against Cloud Code.
			for (const name of Object.keys(requestHeaders)) {
				const lower = name.toLowerCase();
				if (lower === "x-goog-api-key" || lower === PROJECT_ID_HEADER) delete requestHeaders[name];
			}

			const response = await fetch(GENERATE_URL, {
				method: "POST",
				headers: requestHeaders,
				body: JSON.stringify(requestBody),
				signal: options?.signal,
			});
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);

			if (!response.ok) {
				const errorText = await response.text().catch(() => "");
				throw new Error(`Cloud Code Assist API error (${response.status}): ${extractErrorMessage(errorText)}`);
			}
			if (!response.body) throw new Error("No response body");

			stream.push({ type: "start", partial: output });
			let currentBlock: TextContent | ThinkingContent | null = null;
			const blocks = output.content;
			const blockIndex = () => blocks.length - 1;

			const closeCurrentBlock = () => {
				if (!currentBlock) return;
				if (currentBlock.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: blockIndex(),
						content: currentBlock.text,
						partial: output,
					});
				} else {
					stream.push({
						type: "thinking_end",
						contentIndex: blockIndex(),
						content: currentBlock.thinking,
						partial: output,
					});
				}
			};

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			const abortHandler = () => {
				void reader.cancel().catch(() => {});
			};
			options?.signal?.addEventListener("abort", abortHandler);

			try {
				while (true) {
					if (options?.signal?.aborted) throw new Error("Request was aborted");
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split(/\r?\n/);
					buffer = lines.pop() ?? "";

					for (const rawLine of lines) {
						if (!rawLine.startsWith("data:")) continue;
						const payload = unwrapDataLine(rawLine).slice(5).trim();
						if (!payload || payload === "[DONE]") continue;

						let chunk: AntigravityChunk;
						try {
							chunk = JSON.parse(payload) as AntigravityChunk;
						} catch {
							continue;
						}

						output.responseId ||= chunk.responseId;
						const candidate = chunk.candidates?.[0];
						for (const part of candidate?.content?.parts ?? []) {
							if (part.text !== undefined) {
								const isThinking = isThinkingPart(part);
								if (
									!currentBlock ||
									(isThinking && currentBlock.type !== "thinking") ||
									(!isThinking && currentBlock.type !== "text")
								) {
									closeCurrentBlock();
									if (isThinking) {
										currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
										output.content.push(currentBlock);
										stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
									} else {
										currentBlock = { type: "text", text: "" };
										output.content.push(currentBlock);
										stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
									}
								}
								if (currentBlock.type === "thinking") {
									currentBlock.thinking += part.text;
									currentBlock.thinkingSignature = retainThoughtSignature(
										currentBlock.thinkingSignature,
										part.thoughtSignature,
									);
									stream.push({
										type: "thinking_delta",
										contentIndex: blockIndex(),
										delta: part.text,
										partial: output,
									});
								} else {
									currentBlock.text += part.text;
									currentBlock.textSignature = retainThoughtSignature(
										currentBlock.textSignature,
										part.thoughtSignature,
									);
									stream.push({
										type: "text_delta",
										contentIndex: blockIndex(),
										delta: part.text,
										partial: output,
									});
								}
							}

							if (part.functionCall) {
								closeCurrentBlock();
								currentBlock = null;

								const providedId = part.functionCall.id;
								const needsNewId =
									!providedId || output.content.some((b) => b.type === "toolCall" && b.id === providedId);
								const toolCall: ToolCall = {
									type: "toolCall",
									id: needsNewId ? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}` : providedId,
									name: part.functionCall.name || "",
									arguments: part.functionCall.args ?? {},
									...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
								};

								output.content.push(toolCall);
								stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
								stream.push({
									type: "toolcall_delta",
									contentIndex: blockIndex(),
									delta: JSON.stringify(toolCall.arguments),
									partial: output,
								});
								stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
							}
						}

						if (candidate?.finishReason) {
							output.rawStopReason = candidate.finishReason;
							output.stopReason = mapStopReasonString(candidate.finishReason);
							if (output.content.some((b) => b.type === "toolCall")) output.stopReason = "toolUse";
						}

						if (chunk.usageMetadata) {
							const usage = chunk.usageMetadata;
							output.usage = {
								input: (usage.promptTokenCount || 0) - (usage.cachedContentTokenCount || 0),
								output: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
								cacheRead: usage.cachedContentTokenCount || 0,
								cacheWrite: 0,
								reasoning: usage.thoughtsTokenCount || 0,
								totalTokens: usage.totalTokenCount || 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							};
							calculateCost(model, output.usage);
						}
					}
				}
			} finally {
				options?.signal?.removeEventListener("abort", abortHandler);
			}

			closeCurrentBlock();

			if (options?.signal?.aborted) throw new Error("Request was aborted");
			// Cloud Code closes the stream without a finish reason on a clean stop.
			if (output.stopReason === "pending") output.stopReason = "stop";
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(
					output.rawStopReason ? `Provider stopped with: ${output.rawStopReason}` : "An unknown error occurred",
				);
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"google-antigravity", SimpleStreamOptions> = (
	model: Model<"google-antigravity">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) throw new Error("Google AI Pro requires OAuth authentication. Use /login to authenticate.");

	const base = buildBaseOptions(model, context, options, apiKey);
	if (!options?.reasoning) {
		return stream(model, context, { ...base, thinking: { enabled: false } } satisfies GoogleAntigravityOptions);
	}

	// Mirror the official Antigravity CLI, which sends a thinking budget rather
	// than the Gemini API's `thinkingLevel`. Budgeting through the shared helper
	// also keeps the budget inside the model's output cap, which Cloud Code
	// validates strictly.
	const clamped = clampThinkingLevel(model, options.reasoning);
	const effort = clamped === "off" ? "high" : clamped;
	const { maxTokens, thinkingBudget } = adjustMaxTokensForThinking(
		base.maxTokens,
		model.maxTokens,
		effort,
		options.thinkingBudgets,
	);

	return stream(model, context, {
		...base,
		maxTokens,
		thinking: { enabled: true, budgetTokens: thinkingBudget },
	} satisfies GoogleAntigravityOptions);
};
