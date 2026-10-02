import fsPromises, { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantImages,
	fauxAssistantMessage,
	fauxToolCall,
	type ImageModel,
	type ImagesContext,
	type ImagesOptions,
	type JsonObject,
} from "@shuv1337/shuvpi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createImageFilesExtension, type ImageFilesDetails } from "../../src/extensions/image-files/index.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const MODEL: ImageModel<"test-images"> = {
	type: "image",
	provider: "painter",
	id: "fixture",
	name: "Fixture",
	api: "test-images",
	baseUrl: "https://images.invalid/v1",
	input: ["text", "image"],
	output: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const harnesses: Harness[] = [];
const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function setup(
	generate?: (context: ImagesContext, options: ImagesOptions | undefined) => Promise<AssistantImages>,
) {
	const outputDirectory = await mkdtemp(join(tmpdir(), "image-files-test-"));
	directories.push(outputDirectory);
	const calls: ImagesContext[] = [];
	const harness = await createHarness({
		settings: { images: { autoResize: false } },
		extensionFactories: [createImageFilesExtension({ outputDirectory, model: MODEL })],
	});
	harnesses.push(harness);
	harness.session.modelRuntime.registerProvider("painter", {
		apiKey: "fixture-key",
		models: [MODEL],
		images: {
			"test-images": {
				generateImages: async (_model, context, options) => {
					calls.push(context);
					if (generate) return generate(context, options);
					return {
						api: MODEL.api,
						provider: MODEL.provider,
						model: MODEL.id,
						timestamp: 0,
						stopReason: "stop",
						output: [
							{ type: "text", text: "Generated two images" },
							{ type: "image", data: PNG, mimeType: "image/png" },
							{ type: "image", data: PNG, mimeType: "image/png" },
						],
						usage: {
							input: 2,
							output: 2,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 4,
							cost: { input: 0, output: 0.04, cacheRead: 0, cacheWrite: 0, total: 0.04 },
						},
					};
				},
			},
		},
	});
	return { harness, outputDirectory, calls };
}

async function run(harness: Harness, args: JsonObject) {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("generate_image", args), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("generate an image");
	return getToolResult(harness, "generate_image");
}

describe("optional image file adapter", () => {
	it("passes structured prompts and local/data URL/base64 references to native image models and returns files plus image blocks", async () => {
		const { harness, calls, outputDirectory } = await setup();
		await writeFile(join(harness.tempDir, "reference.png"), Buffer.from(PNG, "base64"));
		const result = await run(harness, {
			subject: "A fox",
			action: "running",
			style: "watercolor",
			changes: ["Make the tail green"],
			preserve: "the face",
			aspect_ratio: "16:9",
			input_images: [
				{ path: "reference.png" },
				{ data: `data:image/png;base64,${PNG}` },
				{ data: PNG, mime_type: "image/png" },
			],
		});
		expect(result.isError).toBe(false);
		expect(calls).toHaveLength(1);
		expect(calls[0].input[0]).toMatchObject({ type: "text", text: expect.stringContaining("Make the tail green") });
		expect(calls[0].input.slice(1)).toEqual(
			Array.from({ length: 3 }, () => ({ type: "image", data: PNG, mimeType: "image/png" })),
		);
		const details = result.details as unknown as ImageFilesDetails;
		expect(details.imageCount).toBe(2);
		expect(new Set(details.imagePaths).size).toBe(2);
		for (const file of details.imagePaths) {
			expect(file.startsWith(`${outputDirectory}/`)).toBe(true);
			expect(await readFile(file)).toEqual(Buffer.from(PNG, "base64"));
			if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
		}
		expect(result.content.filter((part) => part.type === "image")).toHaveLength(2);
		expect(result.usage?.cost.total).toBeCloseTo(0.04);
		expect(harness.session.getSessionStats().cost).toBeCloseTo(0.04);
	});

	it.each<JsonObject>([
		{ data: "bad base64", mime_type: "image/png" },
		{ data: PNG },
		{ data: PNG, mime_type: "image/jpeg" },
		{ path: "missing.png", data: PNG, mime_type: "image/png" },
		{ path: "missing.png" },
	])("rejects invalid references before requesting images: %j", async (input) => {
		const { harness, calls, outputDirectory } = await setup();
		const result = await run(harness, { subject: "A fox", input_images: [input] });
		expect(result.isError).toBe(true);
		expect(calls).toHaveLength(0);
		expect(await readdir(outputDirectory)).toEqual([]);
	});

	it("rejects an unknown chosen model without silently switching providers", async () => {
		const { harness, calls } = await setup();
		const result = await run(harness, { subject: "A fox", model: { provider: "painter", id: "missing" } });
		expect(result.isError).toBe(true);
		expect(calls).toHaveLength(0);
		expect(JSON.stringify(result.content)).toContain("Unknown image model painter/missing");
	});

	it("cleans up its entire output batch when a later write fails", async () => {
		const { harness, outputDirectory } = await setup();
		const original = fsPromises.writeFile;
		let writes = 0;
		vi.spyOn(fsPromises, "writeFile").mockImplementation(async (file, data, options) => {
			if (String(file).endsWith(".png") && ++writes === 2) throw new Error("fixture disk failure");
			return original(file, data, options);
		});
		syncBuiltinESMExports();
		const result = await run(harness, { subject: "A fox" });
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("fixture disk failure");
		expect(writes).toBe(2);
		expect(await readdir(outputDirectory)).toEqual([]);
	});

	it("forwards cancellation and leaves no outputs", async () => {
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const { harness, outputDirectory } = await setup(async (_context, options) => {
			started();
			await new Promise<void>((resolve) => {
				options?.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return {
				api: MODEL.api,
				provider: MODEL.provider,
				model: MODEL.id,
				timestamp: 0,
				stopReason: "aborted",
				output: [],
			};
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("generate_image", { subject: "A fox" }), { stopReason: "toolUse" }),
		]);
		const prompt = harness.session.prompt("draw");
		await ready;
		await harness.session.abort();
		await prompt;
		expect(await readdir(outputDirectory)).toEqual([]);
	});

	it("does not leave files for a malformed later image in a provider batch", async () => {
		const { harness, outputDirectory } = await setup(async () => ({
			api: MODEL.api,
			provider: MODEL.provider,
			model: MODEL.id,
			timestamp: 0,
			stopReason: "stop",
			output: [
				{ type: "image", data: PNG, mimeType: "image/png" },
				{ type: "image", data: "garbage", mimeType: "image/png" },
			],
		}));
		const result = await run(harness, { subject: "A fox" });
		expect(result.isError).toBe(true);
		expect(await readdir(outputDirectory)).toEqual([]);
	});
});
