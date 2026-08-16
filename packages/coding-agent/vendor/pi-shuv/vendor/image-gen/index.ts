/**
 * Image Generation Extension for pi
 *
 * Registers a `generate_image` tool for creating and editing images
 * via Gemini, OpenRouter, or Antigravity backends.
 *
 * Provider priority (auto mode): Antigravity -> OpenRouter -> Gemini
 *
 * Configuration via environment variables:
 *   PI_IMAGE_PROVIDER  — Force provider: "antigravity" | "gemini" | "openrouter" | "auto" (default: "auto")
 *
 * Credentials (at least one required):
 *   - Antigravity: `pi login google-antigravity`
 *   - OpenRouter:  OPENROUTER_API_KEY env var
 *   - Gemini:      GEMINI_API_KEY or GOOGLE_API_KEY env var
 */
import { readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@shuv1337/shuvpi-ai";
import { getEnvApiKey } from "@shuv1337/shuvpi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@shuv1337/shuvpi-coding-agent";
import { type Static, Type } from "@shuv1337/shuvpi-ai";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "gemini-3-pro-image-preview";
const DEFAULT_OPENROUTER_MODEL = "google/gemini-3-pro-image-preview";
const DEFAULT_ANTIGRAVITY_MODEL = "gemini-3-pro-image";
const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

const ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const IMAGE_SYSTEM_INSTRUCTION =
	"You are an AI image generator. Generate images based on user descriptions. Focus on creating high-quality, visually appealing images that match the user's request.";

const ANTIGRAVITY_USER_AGENT = (() => {
	const version = process.env.PI_AI_ANTIGRAVITY_VERSION || "1.104.0";
	return `antigravity/${version} darwin/arm64`;
})();

const TOOL_DESCRIPTION = `Generate or edit images using Gemini image models.

Provide structured parameters for best results. Tool assembles into optimized prompt.

When using multiple input_images, describe each image's role in subject or scene field:
- "Use Image 1 for the character's face and outfit, Image 2 for the pose, Image 3 for the background environment"
- "Match the color palette from Image 1, apply the lighting style from Image 2"

Returns generated image saved to disk. Response includes file path where image was written.

Caution:
- For photoreal: add "ultra-detailed, realistic, natural skin texture" to style
- For posters/cards: use 9:16 aspect ratio with negative space for text placement
- For iteration: use changes for targeted adjustments rather than regenerating from scratch
- For text: add "sharp, legible, correctly spelled" for important text; keep text short
- For diagrams: include "scientifically accurate" in style and provide facts explicitly`;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type ImageProvider = "antigravity" | "gemini" | "openrouter";

interface ImageApiKey {
	provider: ImageProvider;
	apiKey: string;
	projectId?: string;
}

interface InlineImageData {
	data: string;
	mimeType: string;
}

interface GeminiPart {
	text?: string;
	inlineData?: { data?: string; mimeType?: string };
}

interface GeminiCandidate {
	content?: { parts?: GeminiPart[] };
}

interface GeminiPromptFeedback {
	blockReason?: string;
}

interface GeminiUsageMetadata {
	promptTokenCount?: number;
	candidatesTokenCount?: number;
	totalTokenCount?: number;
}

interface GeminiGenerateContentResponse {
	candidates?: GeminiCandidate[];
	promptFeedback?: GeminiPromptFeedback;
	usageMetadata?: GeminiUsageMetadata;
}

interface OpenRouterContentPart {
	type: "text" | "image_url";
	text?: string;
	image_url?: { url: string };
}

interface OpenRouterMessage {
	content?: string | OpenRouterContentPart[];
	images?: Array<string | { image_url?: { url: string } }>;
}

interface OpenRouterResponse {
	choices?: Array<{ message?: OpenRouterMessage }>;
}

interface AntigravityRequest {
	project: string;
	model: string;
	request: {
		contents: Array<{ role: "user"; parts: Array<{ text?: string; inlineData?: InlineImageData }> }>;
		systemInstruction?: { parts: Array<{ text: string }> };
		generationConfig?: {
			responseModalities?: string[];
			imageConfig?: { aspectRatio?: string; imageSize?: string };
			candidateCount?: number;
		};
		safetySettings?: Array<{ category: string; threshold: string }>;
	};
	requestType?: string;
	userAgent?: string;
	requestId?: string;
}

interface AntigravityResponseChunk {
	response?: {
		candidates?: Array<{
			content?: {
				role: string;
				parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }>;
			};
		}>;
		usageMetadata?: GeminiUsageMetadata;
	};
}

interface ImageToolDetails {
	provider: ImageProvider;
	model: string;
	imageCount: number;
	imagePaths: string[];
	images: InlineImageData[];
	responseText?: string;
	promptFeedback?: GeminiPromptFeedback;
	usage?: GeminiUsageMetadata;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter schema
// ─────────────────────────────────────────────────────────────────────────────

const aspectRatioSchema = StringEnum(["1:1", "3:4", "4:3", "9:16", "16:9"], {
	description: "Aspect ratio (1:1, 3:4, 4:3, 9:16, 16:9).",
});
const imageSizeSchema = StringEnum(["1024x1024", "1536x1024", "1024x1536"], {
	description: "Image size, mainly for gemini-3-pro-image-preview.",
});

const inputImageSchema = Type.Object(
	{
		path: Type.Optional(Type.String({ description: "Path to an input image file." })),
		data: Type.Optional(Type.String({ description: "Base64 image data or a data: URL." })),
		mime_type: Type.Optional(Type.String({ description: "Required for raw base64 data." })),
	},
	{ additionalProperties: false },
);

const imageParamsSchema = Type.Object(
	{
		subject: Type.String({
			description:
				"Main subject with key descriptors (e.g., 'A stoic robot barista with glowing blue optics', 'A weathered lighthouse on a rocky cliff').",
		}),
		action: Type.Optional(
			Type.String({
				description: "What the subject is doing (e.g., 'pouring latte art', 'standing against crashing waves').",
			}),
		),
		scene: Type.Optional(
			Type.String({
				description:
					"Location or environment (e.g., 'in a futuristic cafe on Mars', 'during a violent thunderstorm at dusk').",
			}),
		),
		composition: Type.Optional(
			Type.String({
				description:
					"Camera angle, framing, depth of field (e.g., 'low-angle close-up, shallow depth of field', 'wide establishing shot').",
			}),
		),
		lighting: Type.Optional(
			Type.String({
				description:
					"Lighting setup and mood (e.g., 'warm rim lighting', 'golden hour backlight', 'hard noon shadows').",
			}),
		),
		style: Type.Optional(
			Type.String({
				description:
					"Artistic style, mood, color grading (e.g., 'film noir mood, cinematic color grading', 'Studio Ghibli watercolor', 'photorealistic').",
			}),
		),
		camera: Type.Optional(
			Type.String({
				description:
					"Lens and camera specs (e.g., 'Shot on 35mm, f/1.8', 'macro lens, extreme close-up', '85mm portrait lens').",
			}),
		),
		text: Type.Optional(
			Type.String({
				description:
					"Text to render in image with specs: exact wording in quotes, font style, color, placement (e.g., 'Headline \"URBAN EXPLORER\" in bold white sans-serif at top center').",
			}),
		),
		changes: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"For edits: specific changes to make (e.g., ['Change the tie to green', 'Remove the car in background']). Use with input_images.",
			}),
		),
		preserve: Type.Optional(
			Type.String({
				description:
					"For edits: what to keep unchanged (e.g., 'identity, face, hairstyle, lighting'). Use with input_images and changes.",
			}),
		),
		aspect_ratio: Type.Optional(aspectRatioSchema),
		image_size: Type.Optional(imageSizeSchema),
		input_images: Type.Optional(
			Type.Array(inputImageSchema, {
				description: "Optional input images for edits or variations.",
			}),
		),
		timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 120)" })),
	},
	{ additionalProperties: false },
);

type ImageParams = Static<typeof imageParamsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function assemblePrompt(params: ImageParams): string {
	const parts: string[] = [];
	const subjectParts = [params.subject];
	if (params.action) subjectParts.push(params.action);
	if (params.scene) subjectParts.push(params.scene);
	parts.push(subjectParts.join(", "));

	if (params.composition) parts.push(params.composition);
	if (params.lighting) parts.push(params.lighting);
	if (params.camera) parts.push(params.camera);
	if (params.style) parts.push(params.style);

	let prompt = `${parts.map(p => p.replace(/[.!,;:]+$/, "")).join(". ")}.`;

	if (params.text) {
		prompt += `\n\nText: ${params.text}`;
	}
	if (params.changes?.length) {
		prompt += `\n\nChanges:\n${params.changes.map(c => `- ${c}`).join("\n")}`;
		if (params.preserve) {
			prompt += `\n\nPreserve: ${params.preserve}`;
		}
	}
	return prompt;
}

function normalizeDataUrl(data: string): { data: string; mimeType?: string } {
	const match = data.match(/^data:([^;]+);base64,(.+)$/);
	if (!match) return { data };
	return { data: match[2] ?? "", mimeType: match[1] };
}

function toDataUrl(image: InlineImageData): string {
	return `data:${image.mimeType};base64,${image.data}`;
}

function resolveOpenRouterModel(model: string): string {
	return model.includes("/") ? model : `google/${model}`;
}

function getExtensionForMime(mimeType: string): string {
	const map: Record<string, string> = {
		"image/png": "png",
		"image/jpeg": "jpg",
		"image/gif": "gif",
		"image/webp": "webp",
	};
	return map[mimeType] ?? "png";
}

async function saveImageToTemp(image: InlineImageData): Promise<string> {
	const ext = getExtensionForMime(image.mimeType);
	const filename = `pi-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
	const filepath = path.join(os.tmpdir(), filename);
	await writeFile(filepath, Buffer.from(image.data, "base64"));
	return filepath;
}

async function saveImagesToTemp(images: InlineImageData[]): Promise<string[]> {
	return Promise.all(images.map(saveImageToTemp));
}

function buildResponseSummary(
	provider: ImageProvider,
	model: string,
	imagePaths: string[],
	responseText: string | undefined,
): string {
	const lines = [`Provider: ${provider}`, `Model: ${model}`, `Generated ${imagePaths.length} image(s):`];
	for (const p of imagePaths) {
		lines.push(`  ${p}`);
	}
	if (responseText) {
		lines.push("", responseText.trim());
	}
	return lines.join("\n");
}

/** Detect image MIME from magic bytes (avoids file-type dependency). */
function detectImageMime(bytes: Uint8Array): string | null {
	if (bytes.length < 4) return null;
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return "image/webp";
	}
	return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE parsing (self-contained, no external dependency)
// ─────────────────────────────────────────────────────────────────────────────

async function* readSseJson<T>(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<T> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			if (signal?.aborted) break;
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith("data:")) continue;
				const payload = trimmed.slice(5).trim();
				if (payload === "[DONE]") return;
				try {
					yield JSON.parse(payload) as T;
				} catch {
					// skip malformed chunks
				}
			}
		}
		// flush remaining
		buffer += decoder.decode();
		if (buffer.trim().startsWith("data:")) {
			const payload = buffer.trim().slice(5).trim();
			if (payload && payload !== "[DONE]") {
				try {
					yield JSON.parse(payload) as T;
				} catch {
					// skip
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Image loading
// ─────────────────────────────────────────────────────────────────────────────

async function loadImageFromPath(imagePath: string, cwd: string): Promise<InlineImageData> {
	const resolved = path.isAbsolute(imagePath) ? imagePath : path.resolve(cwd, imagePath);
	try {
		const bytes = await readFile(resolved);
		if (bytes.length > MAX_IMAGE_SIZE) {
			throw new Error(`Image file too large: ${imagePath}`);
		}
		const mimeType = detectImageMime(bytes);
		if (!mimeType) {
			throw new Error(`Unsupported image type: ${imagePath}`);
		}
		return { data: bytes.toString("base64"), mimeType };
	} catch (err) {
		if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
			throw new Error(`Image file not found: ${imagePath}`);
		}
		throw err;
	}
}

async function loadImageFromUrl(imageUrl: string, signal?: AbortSignal): Promise<InlineImageData> {
	if (imageUrl.startsWith("data:")) {
		const normalized = normalizeDataUrl(imageUrl.trim());
		if (!normalized.mimeType) throw new Error("mime_type is required when providing raw base64 data.");
		if (!normalized.data) throw new Error("Image data is empty.");
		return { data: normalized.data, mimeType: normalized.mimeType };
	}
	const response = await fetch(imageUrl, { signal });
	if (!response.ok) {
		const rawText = await response.text();
		throw new Error(`Image download failed (${response.status}): ${rawText}`);
	}
	const contentType = response.headers.get("content-type")?.split(";")[0];
	if (!contentType?.startsWith("image/")) {
		throw new Error(`Unsupported image type from URL: ${imageUrl}`);
	}
	const buffer = Buffer.from(await response.arrayBuffer());
	return { data: buffer.toString("base64"), mimeType: contentType };
}

async function resolveInputImage(
	input: { path?: string; data?: string; mime_type?: string },
	cwd: string,
): Promise<InlineImageData> {
	if (input.path) return loadImageFromPath(input.path, cwd);
	if (input.data) {
		const normalized = normalizeDataUrl(input.data.trim());
		const mimeType = normalized.mimeType ?? input.mime_type;
		if (!mimeType) throw new Error("mime_type is required when providing raw base64 data.");
		if (!normalized.data) throw new Error("Image data is empty.");
		return { data: normalized.data, mimeType };
	}
	throw new Error("input_images entries must include either path or data.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider credential resolution
// ─────────────────────────────────────────────────────────────────────────────

function parseAntigravityCredentials(raw: string): { accessToken: string; projectId: string } | null {
	try {
		const parsed = JSON.parse(raw) as { token?: string; projectId?: string };
		if (parsed.token && parsed.projectId) {
			return { accessToken: parsed.token, projectId: parsed.projectId };
		}
	} catch {
		// not valid JSON
	}
	return null;
}

async function findAntigravityCredentials(ctx: ExtensionContext): Promise<ImageApiKey | null> {
	const apiKey = await ctx.modelRegistry.getApiKeyForProvider("google-antigravity");
	if (!apiKey) return null;
	const parsed = parseAntigravityCredentials(apiKey);
	if (!parsed) return null;
	return { provider: "antigravity", apiKey: parsed.accessToken, projectId: parsed.projectId };
}

async function findImageApiKey(ctx: ExtensionContext): Promise<ImageApiKey | null> {
	const preferred = process.env.PI_IMAGE_PROVIDER;

	if (preferred === "antigravity") {
		const cred = await findAntigravityCredentials(ctx);
		if (cred) return cred;
	}
	if (preferred === "gemini") {
		const key = getEnvApiKey("google") || process.env.GOOGLE_API_KEY;
		if (key) return { provider: "gemini", apiKey: key };
	}
	if (preferred === "openrouter") {
		const key = getEnvApiKey("openrouter");
		if (key) return { provider: "openrouter", apiKey: key };
	}

	// Auto: Antigravity -> OpenRouter -> Gemini
	const antigravity = await findAntigravityCredentials(ctx);
	if (antigravity) return antigravity;

	const orKey = getEnvApiKey("openrouter");
	if (orKey) return { provider: "openrouter", apiKey: orKey };

	const geminiKey = getEnvApiKey("google") || process.env.GOOGLE_API_KEY;
	if (geminiKey) return { provider: "gemini", apiKey: geminiKey };

	return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider execution
// ─────────────────────────────────────────────────────────────────────────────

function buildAntigravityRequest(
	prompt: string,
	model: string,
	projectId: string,
	aspectRatio: string | undefined,
	imageSize: string | undefined,
	inputImages: InlineImageData[],
): AntigravityRequest {
	const parts: Array<{ text?: string; inlineData?: InlineImageData }> = [];
	for (const image of inputImages) {
		parts.push({ inlineData: image });
	}
	parts.push({ text: prompt });

	return {
		project: projectId,
		model,
		request: {
			contents: [{ role: "user", parts }],
			systemInstruction: { parts: [{ text: IMAGE_SYSTEM_INSTRUCTION }] },
			generationConfig: {
				responseModalities: ["Image"],
				imageConfig: aspectRatio || imageSize ? { aspectRatio, imageSize } : undefined,
				candidateCount: 1,
			},
			safetySettings: [
				{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
				{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
				{ category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
				{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
				{ category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_ONLY_HIGH" },
			],
		},
		requestType: "agent",
		requestId: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
		userAgent: "antigravity",
	};
}

async function executeAntigravity(
	apiKey: ImageApiKey,
	params: ImageParams,
	resolvedImages: InlineImageData[],
	signal?: AbortSignal,
): Promise<{ images: InlineImageData[]; responseText?: string; usage?: GeminiUsageMetadata }> {
	if (!apiKey.projectId) throw new Error("Missing projectId in antigravity credentials");

	const requestBody = buildAntigravityRequest(
		assemblePrompt(params),
		DEFAULT_ANTIGRAVITY_MODEL,
		apiKey.projectId,
		params.aspect_ratio,
		params.image_size,
		resolvedImages,
	);

	const response = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey.apiKey}`,
			"Content-Type": "application/json",
			Accept: "text/event-stream",
			"User-Agent": ANTIGRAVITY_USER_AGENT,
		},
		body: JSON.stringify(requestBody),
		signal,
	});

	if (!response.ok) {
		const errorText = await response.text();
		let message = errorText;
		try {
			message = (JSON.parse(errorText) as { error?: { message?: string } }).error?.message ?? message;
		} catch {
			// keep raw
		}
		throw new Error(`Antigravity image request failed (${response.status}): ${message}`);
	}

	if (!response.body) throw new Error("No response body");

	const textParts: string[] = [];
	const images: InlineImageData[] = [];
	let usage: GeminiUsageMetadata | undefined;

	for await (const chunk of readSseJson<AntigravityResponseChunk>(response.body, signal)) {
		const data = chunk.response;
		if (!data?.candidates) continue;
		for (const candidate of data.candidates) {
			for (const part of candidate.content?.parts ?? []) {
				if (part.text) textParts.push(part.text);
				if (part.inlineData?.data && part.inlineData.mimeType) {
					images.push({ data: part.inlineData.data, mimeType: part.inlineData.mimeType });
				}
			}
		}
		if (data.usageMetadata) usage = data.usageMetadata;
	}

	return { images, responseText: textParts.length > 0 ? textParts.join(" ") : undefined, usage };
}

async function executeOpenRouter(
	apiKey: ImageApiKey,
	params: ImageParams,
	resolvedImages: InlineImageData[],
	signal?: AbortSignal,
): Promise<{ images: InlineImageData[]; responseText?: string }> {
	const resolvedModel = resolveOpenRouterModel(DEFAULT_OPENROUTER_MODEL);
	const contentParts: OpenRouterContentPart[] = [{ type: "text", text: assemblePrompt(params) }];
	for (const image of resolvedImages) {
		contentParts.push({ type: "image_url", image_url: { url: toDataUrl(image) } });
	}

	const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey.apiKey}` },
		body: JSON.stringify({ model: resolvedModel, messages: [{ role: "user" as const, content: contentParts }] }),
		signal,
	});

	const rawText = await response.text();
	if (!response.ok) {
		let message = rawText;
		try {
			message = (JSON.parse(rawText) as { error?: { message?: string } }).error?.message ?? message;
		} catch {
			// keep raw
		}
		throw new Error(`OpenRouter image request failed (${response.status}): ${message}`);
	}

	const data = JSON.parse(rawText) as OpenRouterResponse;
	const msg = data.choices?.[0]?.message;

	// Extract text
	let responseText: string | undefined;
	if (msg) {
		if (typeof msg.content === "string" && msg.content.trim()) {
			responseText = msg.content.trim();
		} else if (Array.isArray(msg.content)) {
			const texts = msg.content
				.filter(p => p.type === "text" && p.text)
				.map(p => p.text!)
				.join("\n")
				.trim();
			if (texts) responseText = texts;
		}
	}

	// Extract images
	const imageUrls: string[] = [];
	if (msg) {
		for (const img of msg.images ?? []) {
			if (typeof img === "string") imageUrls.push(img);
			else if (img.image_url?.url) imageUrls.push(img.image_url.url);
		}
		if (Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (part.type === "image_url" && part.image_url?.url) imageUrls.push(part.image_url.url);
			}
		}
	}

	const images: InlineImageData[] = [];
	for (const url of imageUrls) {
		images.push(await loadImageFromUrl(url, signal));
	}
	return { images, responseText };
}

async function executeGemini(
	apiKey: ImageApiKey,
	params: ImageParams,
	resolvedImages: InlineImageData[],
	signal?: AbortSignal,
): Promise<{
	images: InlineImageData[];
	responseText?: string;
	promptFeedback?: GeminiPromptFeedback;
	usage?: GeminiUsageMetadata;
}> {
	const parts: Array<{ text?: string; inlineData?: InlineImageData }> = [];
	for (const image of resolvedImages) {
		parts.push({ inlineData: image });
	}
	parts.push({ text: assemblePrompt(params) });

	const generationConfig: {
		responseModalities: string[];
		imageConfig?: { aspectRatio?: string; imageSize?: string };
	} = { responseModalities: ["Image"] };
	if (params.aspect_ratio || params.image_size) {
		generationConfig.imageConfig = { aspectRatio: params.aspect_ratio, imageSize: params.image_size };
	}

	const response = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(DEFAULT_MODEL)}:generateContent`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey.apiKey },
			body: JSON.stringify({ contents: [{ role: "user" as const, parts }], generationConfig }),
			signal,
		},
	);

	const rawText = await response.text();
	if (!response.ok) {
		let message = rawText;
		try {
			message = (JSON.parse(rawText) as { error?: { message?: string } }).error?.message ?? message;
		} catch {
			// keep raw
		}
		throw new Error(`Gemini image request failed (${response.status}): ${message}`);
	}

	const data = JSON.parse(rawText) as GeminiGenerateContentResponse;
	const allParts: GeminiPart[] = [];
	for (const candidate of data.candidates ?? []) {
		allParts.push(...(candidate.content?.parts ?? []));
	}

	const texts = allParts.map(p => p.text).filter((t): t is string => Boolean(t));
	const responseText = texts.join("\n").trim() || undefined;

	const images: InlineImageData[] = [];
	for (const p of allParts) {
		if (p.inlineData?.data && p.inlineData.mimeType) {
			images.push({ data: p.inlineData.data, mimeType: p.inlineData.mimeType });
		}
	}

	return { images, responseText, promptFeedback: data.promptFeedback, usage: data.usageMetadata };
}

// ─────────────────────────────────────────────────────────────────────────────
// Result builders
// ─────────────────────────────────────────────────────────────────────────────

function emptyResult(
	provider: ImageProvider,
	model: string,
	responseText: string | undefined,
	extra?: { promptFeedback?: GeminiPromptFeedback; usage?: GeminiUsageMetadata },
) {
	const blocked = extra?.promptFeedback?.blockReason;
	const prefix = blocked ? `Blocked: ${blocked}` : "No image data returned.";
	const suffix = responseText ? `\n\n${responseText}` : "";
	return {
		content: [{ type: "text" as const, text: `${prefix}${suffix}` }],
		details: {
			provider,
			model,
			imageCount: 0,
			imagePaths: [] as string[],
			images: [] as InlineImageData[],
			responseText,
			...extra,
		} satisfies ImageToolDetails,
	};
}

async function successResult(
	provider: ImageProvider,
	model: string,
	images: InlineImageData[],
	responseText: string | undefined,
	extra?: { promptFeedback?: GeminiPromptFeedback; usage?: GeminiUsageMetadata },
) {
	const imagePaths = await saveImagesToTemp(images);
	return {
		content: [{ type: "text" as const, text: buildResponseSummary(provider, model, imagePaths, responseText) }],
		details: {
			provider,
			model,
			imageCount: images.length,
			imagePaths,
			images,
			responseText,
			...extra,
		} satisfies ImageToolDetails,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension entry point
// ─────────────────────────────────────────────────────────────────────────────

export default function imageGenExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "generate_image",
		label: "GenerateImage",
		description: TOOL_DESCRIPTION,
		promptSnippet: "Generate or edit images from structured prompts and optional input images.",
		promptGuidelines: [
			"Use generate_image when the user wants new images, image edits, poster art, mockups, or visual variations.",
			"Provide structured fields like subject, scene, composition, lighting, style, and camera when available.",
			"For edits, pass input_images along with targeted changes and preserve instructions instead of regenerating from scratch.",
			"For important text in the image, keep it short and explicitly request sharp, legible, correctly spelled text.",
		],
		parameters: imageParamsSchema,
		async execute(_toolCallId, params: ImageParams, signal, _onUpdate, ctx) {
			const apiKey = await findImageApiKey(ctx);
			if (!apiKey) {
				throw new Error(
					"No image API credentials found. Login with google-antigravity, or set OPENROUTER_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY.",
				);
			}

			const provider = apiKey.provider;
			const model =
				provider === "antigravity"
					? DEFAULT_ANTIGRAVITY_MODEL
					: provider === "openrouter"
						? DEFAULT_OPENROUTER_MODEL
						: DEFAULT_MODEL;
			const displayModel = provider === "openrouter" ? resolveOpenRouterModel(model) : model;
			const cwd = ctx.sessionManager.getCwd();

			const resolvedImages: InlineImageData[] = [];
			if (params.input_images?.length) {
				for (const input of params.input_images) {
					resolvedImages.push(await resolveInputImage(input, cwd));
				}
			}

			const { timeout: rawTimeout = DEFAULT_TIMEOUT_SECONDS } = params;
			const timeoutMs = Math.max(1, Math.min(600, rawTimeout)) * 1000;
			const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

			if (provider === "antigravity") {
				const result = await executeAntigravity(apiKey, params, resolvedImages, requestSignal);
				if (result.images.length === 0) return emptyResult(provider, model, result.responseText, { usage: result.usage });
				return successResult(provider, model, result.images, result.responseText, { usage: result.usage });
			}

			if (provider === "openrouter") {
				const result = await executeOpenRouter(apiKey, params, resolvedImages, requestSignal);
				if (result.images.length === 0) return emptyResult(provider, displayModel, result.responseText);
				return successResult(provider, displayModel, result.images, result.responseText);
			}

			const result = await executeGemini(apiKey, params, resolvedImages, requestSignal);
			if (result.images.length === 0) {
				return emptyResult(provider, model, result.responseText, {
					promptFeedback: result.promptFeedback,
					usage: result.usage,
				});
			}
			return successResult(provider, model, result.images, result.responseText, {
				promptFeedback: result.promptFeedback,
				usage: result.usage,
			});
		},
	});
}
