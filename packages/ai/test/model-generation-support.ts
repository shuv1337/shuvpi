import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect } from "vitest";
import type { Api, Model } from "../src/types.ts";

export interface MetadataRequest {
	url: string;
	method: string;
	hasAuthorization: boolean;
}

/** Run the production generator with isolated output and entirely mocked metadata I/O. */
export function generateModelCatalog(catalog: Record<string, unknown>): {
	providers: Record<string, Record<string, Model<Api>>>;
	requests: MetadataRequest[];
} {
	const root = mkdtempSync(join(tmpdir(), "shuvpi-catalog-generation-"));
	try {
		const preloadPath = join(root, "mock-catalog.mjs");
		const outputPath = join(root, "catalog");
		const requestsPath = join(root, "requests.jsonl");
		writeFileSync(
			preloadPath,
			`import { appendFileSync } from "node:fs";
const catalog = ${JSON.stringify(catalog)};
globalThis.fetch = async (input, init) => {
  const url = String(input);
  appendFileSync(${JSON.stringify(requestsPath)}, JSON.stringify({ url, method: init?.method ?? "GET", hasAuthorization: new Headers(init?.headers).has("authorization") }) + "\\n");
  if (url === "https://models.dev/api.json") return Response.json(catalog);
  if (url === "https://models.dev/models.json?type=decision") return Response.json({ "typesafe/jev-latest": { name: "Jev", type: "decision", limit: { context: 64000, output: 0 } } });
  if (["https://openrouter.ai/api/v1/models", "https://openrouter.ai/api/v1/models?output_modalities=image", "https://openrouter.ai/api/v1/models?output_modalities=decisions", "https://ai-gateway.vercel.sh/v1/models"].includes(url)) return Response.json({ data: [] });
  if (url === "https://radius.pi.dev/v1/config") return Response.json({ baseUrl: "https://radius.pi.dev", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 4096 }] });
  throw new Error(\`Unexpected fetch: \${url}\`);
};\n`,
		);
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(preloadPath).href,
				"scripts/generate-models.ts",
				"--json-only",
				"--json-output",
				outputPath,
			],
			{ cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 10_000 },
		);
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stderr).toBe("");
		return {
			providers: JSON.parse(readFileSync(join(outputPath, "models.json"), "utf8")),
			requests: readFileSync(requestsPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		};
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
}
