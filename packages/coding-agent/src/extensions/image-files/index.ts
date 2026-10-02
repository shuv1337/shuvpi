import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type ImageContent, type Static, StringEnum, Type } from "@shuv1337/shuvpi-ai";
import { APP_NAME } from "../../config.ts";
import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { detectSupportedImageMimeType } from "../../utils/mime.ts";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MIME_EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
};
export const ImageFilesSchema = Type.Object(
	{
		subject: Type.String({ minLength: 1, description: "Main subject or edit request" }),
		action: Type.Optional(Type.String()),
		scene: Type.Optional(Type.String()),
		composition: Type.Optional(Type.String()),
		lighting: Type.Optional(Type.String()),
		style: Type.Optional(Type.String()),
		camera: Type.Optional(Type.String()),
		text: Type.Optional(Type.String({ description: "Exact text to render and its placement" })),
		changes: Type.Optional(Type.Array(Type.String())),
		preserve: Type.Optional(Type.String()),
		aspect_ratio: Type.Optional(StringEnum(["1:1", "3:4", "4:3", "9:16", "16:9"])),
		image_size: Type.Optional(StringEnum(["1024x1024", "1536x1024", "1024x1536"])),
		input_images: Type.Optional(
			Type.Array(
				Type.Object(
					{
						path: Type.Optional(Type.String()),
						data: Type.Optional(Type.String({ description: "Base64 image data or a data URL" })),
						mime_type: Type.Optional(Type.String({ description: "Required for raw base64" })),
					},
					{ additionalProperties: false },
				),
			),
		),
		model: Type.Optional(Type.Object({ provider: Type.String(), id: Type.String() })),
		timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 600, description: "Timeout in seconds; default 120" })),
	},
	{ additionalProperties: false },
);

type ImageFilesParams = Static<typeof ImageFilesSchema>;
export interface ImageFilesDetails {
	provider: string;
	model: string;
	imageCount: number;
	imagePaths: string[];
	images: Array<{ path: string; mimeType: string }>;
	responseText?: string;
}
export interface ImageFilesOptions {
	/** Image model used when the call does not name one; otherwise use the first available native image model. */
	model?: { provider: string; id: string };
	/** Existing directory under which each call creates its own private output directory. */
	outputDirectory?: string;
}

function assemblePrompt(params: ImageFilesParams): string {
	const sections = [
		params.subject,
		params.action,
		params.scene,
		params.composition,
		params.lighting,
		params.style,
		params.camera,
	].filter(Boolean);
	if (params.text) sections.push(`Text: ${params.text}`);
	if (params.changes?.length) sections.push(`Changes:\n${params.changes.map((change) => `- ${change}`).join("\n")}`);
	if (params.preserve) sections.push(`Preserve: ${params.preserve}`);
	if (params.aspect_ratio) sections.push(`Aspect ratio: ${params.aspect_ratio}`);
	if (params.image_size) sections.push(`Output size: ${params.image_size}`);
	return sections.join("\n\n");
}

function decodeImage(data: string, expectedMime?: string): { bytes: Buffer; mimeType: string } {
	if (!data || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
		throw new Error("Image data is empty, invalid base64 or larger than 20 MiB");
	const bytes = Buffer.from(data, "base64");
	if (bytes.toString("base64").replace(/=+$/, "") !== data.replace(/=+$/, ""))
		throw new Error("Invalid base64 image data");
	const mimeType = detectSupportedImageMimeType(bytes);
	if (!mimeType || !MIME_EXTENSIONS[mimeType]) throw new Error("Unsupported image type; use PNG, JPEG, GIF or WebP");
	if (expectedMime && expectedMime !== mimeType) throw new Error(`Image data is ${mimeType}, not ${expectedMime}`);
	return { bytes, mimeType };
}

async function loadReference(
	input: NonNullable<ImageFilesParams["input_images"]>[number],
	cwd: string,
	signal: AbortSignal,
): Promise<ImageContent> {
	if (Boolean(input.path) === Boolean(input.data))
		throw new Error("Each input image needs exactly one of path or data");
	let data: string;
	let expectedMime = input.mime_type;
	if (input.path) {
		const file = resolve(cwd, input.path);
		if ((await stat(file)).size > MAX_IMAGE_BYTES) throw new Error("Image file is larger than 20 MiB");
		data = (await readFile(file, { signal })).toString("base64");
	} else {
		data = input.data!.trim();
		const match = /^data:([^;]+);base64,(.*)$/.exec(data);
		if (match) {
			if (expectedMime && expectedMime !== match[1]) throw new Error("Image MIME type conflicts with the data URL");
			expectedMime = match[1];
			data = match[2];
		}
		if (!expectedMime) throw new Error("mime_type is required for raw base64 image data");
	}
	const decoded = decodeImage(data, expectedMime);
	return { type: "image", data: decoded.bytes.toString("base64"), mimeType: decoded.mimeType };
}

/** Optional file adapter around upstream's image model discovery, authentication and transport. */
export function createImageFilesExtension(options: ImageFilesOptions = {}): ExtensionFactory {
	return (pi) => {
		pi.registerTool<typeof ImageFilesSchema, ImageFilesDetails>({
			name: "generate_image",
			label: "Generate image",
			description:
				"Generate or edit images using a native image model. Accepts a structured prompt and local or base64 reference images. Returns image blocks and paths to saved files. Specify provider/id to choose a model.",
			promptSnippet: "Generate or edit images and save the outputs to disk.",
			parameters: ImageFilesSchema,
			async execute(_id, params, signal, _onUpdate, ctx) {
				const requestSignal = AbortSignal.any([
					...(signal ? [signal] : []),
					AbortSignal.timeout((params.timeout ?? 120) * 1000),
				]);
				requestSignal.throwIfAborted();
				const references: ImageContent[] = [];
				for (const input of params.input_images ?? [])
					references.push(await loadReference(input, ctx.cwd, requestSignal));
				const selected = params.model ?? options.model;
				const model = selected
					? ctx.modelRegistry.getModelOfType("image", selected.provider, selected.id)
					: (await ctx.modelRegistry.getAvailableOfType("image", undefined, { signal: requestSignal }))[0];
				if (!model)
					throw new Error(
						selected
							? `Unknown image model ${selected.provider}/${selected.id}`
							: "No image model with configured credentials is available",
					);
				const result = await ctx.modelRegistry.generateImages(
					model,
					{ input: [{ type: "text", text: assemblePrompt(params) }, ...references] },
					{ signal: requestSignal },
				);
				requestSignal.throwIfAborted();
				if (result.stopReason !== "stop")
					throw new Error(result.errorMessage ?? `Image generation ${result.stopReason}`);
				const responseText = result.output
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				const images = result.output.filter((part) => part.type === "image");
				// Validate the full batch before creating any output file.
				const decoded = images.map((part) => decodeImage(part.data, part.mimeType));
				const imagePaths: string[] = [];
				let directory: string | undefined;
				try {
					if (images.length)
						directory = await mkdtemp(join(options.outputDirectory ?? tmpdir(), `${APP_NAME}-images-`));
					for (const [index, image] of decoded.entries()) {
						requestSignal.throwIfAborted();
						const file = join(directory!, `image-${index + 1}.${MIME_EXTENSIONS[image.mimeType]}`);
						await writeFile(file, image.bytes, { flag: "wx", mode: 0o600, signal: requestSignal });
						imagePaths.push(file);
					}
					requestSignal.throwIfAborted();
					return {
						content: [
							{
								type: "text",
								text: [
									imagePaths.length ? `Saved images:\n${imagePaths.join("\n")}` : "No image data returned.",
									responseText,
								]
									.filter(Boolean)
									.join("\n\n"),
							},
							...images,
						],
						details: {
							provider: model.provider,
							model: model.id,
							imageCount: images.length,
							imagePaths,
							images: decoded.map((image, index) => ({ path: imagePaths[index], mimeType: image.mimeType })),
							...(responseText ? { responseText } : {}),
						},
						...(result.usage ? { usage: result.usage } : {}),
					};
				} catch (error) {
					if (directory) await rm(directory, { recursive: true, force: true });
					throw error;
				}
			},
		});
	};
}
