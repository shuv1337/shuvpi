import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@shuv1337/shuvpi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import claudeExtension from "../../src/extensions/subagents/claude.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.agent.waitForIdle();
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
});

describe("optional Claude SDK loading", () => {
	it("imports and registers without an SDK, then explains the missing companion when invoked", async () => {
		const harness = await createHarness({ extensionFactories: [claudeExtension] });
		harnesses.push(harness);
		vi.stubEnv("SHUVPI_PACKAGE_DIR", harness.tempDir);
		harness.setResponses([fauxAssistantMessage("received failure")]);
		const runner = harness.session.extensionRunner;
		expect(runner.getToolDefinition("subagent_spawn")).toBeDefined();
		await expect(
			runner
				.getToolDefinition("subagent_spawn")!
				.execute(
					"missing-sdk",
					{ backend: "claude", prompt: "fixture" },
					undefined,
					undefined,
					runner.createToolContext("missing-sdk", undefined),
				),
		).rejects.toThrow("Claude subagents require @anthropic-ai/claude-agent-sdk installed beside");
	});

	it.each([
		{ layout: "main", hoisted: false },
		{ layout: "exports", hoisted: false },
		{ layout: "conditional exports", hoisted: false },
		{ layout: "conditional exports", hoisted: true },
	])("loads $layout with hoisted=$hoisted on first child invocation", async ({ layout, hoisted }) => {
		const harness = await createHarness({ extensionFactories: [claudeExtension] });
		harnesses.push(harness);
		const packageRoot = hoisted ? join(harness.tempDir, "node_modules", "shuvpi") : harness.tempDir;
		mkdirSync(packageRoot, { recursive: true });
		writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "shuvpi" }));
		vi.stubEnv("SHUVPI_PACKAGE_DIR", packageRoot);
		const sdkDir = join(harness.tempDir, "node_modules", "@anthropic-ai", "claude-agent-sdk");
		mkdirSync(sdkDir, { recursive: true });
		const log = join(harness.tempDir, "sdk-calls.jsonl");
		const sdkEntry = layout === "main" ? "sdk.cjs" : "sdk.mjs";
		writeFileSync(
			join(sdkDir, "package.json"),
			JSON.stringify({
				name: "@anthropic-ai/claude-agent-sdk",
				main: layout === "main" ? sdkEntry : "unused.cjs",
				...(layout === "exports" ? { exports: `./${sdkEntry}` } : {}),
				...(layout === "conditional exports"
					? { exports: { ".": { types: "./sdk.d.ts", default: `./${sdkEntry}` } } }
					: {}),
			}),
		);
		writeFileSync(
			join(sdkDir, sdkEntry),
			`
${layout === "main" ? 'const { appendFileSync } = require("node:fs");' : 'import { appendFileSync } from "node:fs";'}
const log = ${JSON.stringify(log)};
appendFileSync(log, JSON.stringify({ event: "load" }) + "\\n");
${layout === "main" ? "exports.query" : "export const query"} = ({ prompt, options }) => ({
  async *[Symbol.asyncIterator]() {
    for await (const message of prompt) appendFileSync(log, JSON.stringify({ event: "prompt", message, cwd: options.cwd, permissionMode: options.permissionMode, disallowedTools: options.disallowedTools }) + "\\n");
    yield { type: "system", session_id: "local-sdk-fixture" };
    yield { type: "result", is_error: false, result: "local SDK reply" };
  },
  async interrupt() {},
  close() {}
});
`,
		);
		expect(existsSync(log)).toBe(false);
		harness.setResponses([fauxAssistantMessage("received completion")]);
		const runner = harness.session.extensionRunner;
		await runner
			.getToolDefinition("subagent_spawn")!
			.execute(
				"local-sdk",
				{ backend: "claude", prompt: "streamed fixture", model: "fixture-model", effort: "high" },
				undefined,
				undefined,
				runner.createToolContext("local-sdk", undefined),
			);
		await vi.waitFor(() => {
			const calls = readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as unknown);
			expect(calls).toEqual([
				{ event: "load" },
				expect.objectContaining({
					event: "prompt",
					cwd: harness.tempDir,
					permissionMode: "default",
					disallowedTools: ["Agent", "Task", "AskUserQuestion"],
					message: {
						type: "user",
						message: { role: "user", content: "streamed fixture" },
						parent_tool_use_id: null,
						session_id: "",
					},
				}),
			]);
		});
	});
});
