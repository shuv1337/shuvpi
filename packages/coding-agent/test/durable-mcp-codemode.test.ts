import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type ToolResultMessage,
	Type,
} from "@shuv1337/shuvpi-ai";
import { BACKGROUND_CONTEXT } from "@shuv1337/shuvpi-chord/context";
import {
	type Conversation,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	hook,
	type JsonObject,
	MemoryStorage,
	type TaskId,
	ToolEffectsDoc,
	ToolTask,
} from "@shuv1337/shuvpi-durable";
import { McpClient, StdioTransport } from "@shuv1337/shuvpi-mcp";
import { afterEach, describe, expect, it } from "vitest";
import {
	createDurableCodemodeTool,
	createDurableMcpTool,
	DurableCodemodeStore,
} from "../src/core/durable-workflows/codemode.ts";

const context = BACKGROUND_CONTEXT;
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup() {
	const directory = mkdtempSync(join(tmpdir(), "pi-durable-mcp-"));
	const callsFile = join(directory, "calls.jsonl");
	writeFileSync(callsFile, "");
	cleanup.push(async () => rmSync(directory, { recursive: true, force: true }));
	const client = new McpClient({ name: "durable-seam-test", version: "1" });
	cleanup.push(() => client.close());
	await client.connect(
		new StdioTransport({
			command: process.execPath,
			args: [
				"--experimental-strip-types",
				new URL("./fixtures/durable-mcp-server.ts", import.meta.url).pathname,
				callsFile,
			],
		}),
	);
	const [remote] = await client.listTools();
	const mcp = createDurableMcpTool(
		{
			server: "fixture",
			tool: remote!,
			name: "mcp__fixture__echo",
			exposure: "direct",
			namespace: { name: "fixture" },
			timeoutMs: 5_000,
			getClient: async () => client,
		},
		{ effect: "mutation", replay: "unsafe", compatibility: "echo/1", requiredPolicies: ["local-access"] },
	);
	const codemode = createDurableCodemodeTool();
	const registry = createRegistry();
	registry.install(
		defineExtension({
			name: "test-tools",
			tools: [mcp, codemode],
			hooks: [
				hook(ToolTask, {
					beforeTool(call) {
						if (call.name === mcp.name && call.arguments.text === "veto") return { block: "hook veto" };
						return undefined;
					},
				}),
			],
		}),
	);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const policies: string[] = [];
	const reports: unknown[] = [];
	const harness = await Harness.open(
		new MemoryStorage(),
		{
			models,
			registry,
			onReport: (error) => reports.push(error),
			toolPolicies: [
				{
					id: "local-access",
					compatibility: "1",
					authorize(call) {
						if (call.name !== mcp.name) return;
						policies.push(String(call.arguments.text));
						if (call.arguments.text === "denied") throw new Error("policy veto");
					},
				},
			],
		},
		context,
	);
	cleanup.push(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	harness.resume();
	let ordinal = 0;
	const run = async (name: string, args: JsonObject, conversation: Conversation = root) => {
		const id = `call-${++ordinal}`;
		faux.setResponses([
			fauxAssistantMessage([{ ...fauxToolCall(name, args), id }], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const submission = await conversation.submit({ type: "input", content: "go" }, context);
		await submission.wait(context);
		const entries = await conversation.entries({}, 1000, undefined, context);
		const result = entries.items
			.flatMap((entry) => entry.model ?? [])
			.find((message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === id);
		if (!result) throw new Error(`Missing ${id}; reports: ${reports.map(String).join("; ")}`);
		return result;
	};
	return {
		harness,
		root,
		registry,
		mcp,
		codemode,
		policies,
		reports,
		faux,
		run,
		calls: () =>
			readFileSync(callsFile, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { text: string }),
	};
}

function text(result: ToolResultMessage): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

describe("one Harness with native MCP and actual QuickJS", () => {
	it("retains structured MCP content for direct and nested calls with no nested transcript tool result", async () => {
		const { run, root, calls, reports, mcp } = await setup();
		expect(mcp.effect).toBe("mutation");
		const direct = await run(mcp.name, { text: "direct" });
		expect(direct.structuredContent).toEqual({
			content: [{ type: "text", text: "direct" }],
			structuredContent: { echo: "direct" },
		});
		const nested = await run("codemode", {
			code: 'const r = await tools.mcp__fixture__echo({text:"nested"}); return r.structuredContent.echo;',
		});
		expect(nested.isError).toBe(false);
		expect(text(nested)).toContain("nested");
		const remoteError = await run("codemode", {
			code: 'const r = await tools.mcp__fixture__echo({text:"server-error"}); return [r.isError, r.structuredContent.echo];',
		});
		expect(text(remoteError)).toContain('[true,"server-error"]');
		expect(calls().map((call) => call.text)).toEqual(["direct", "nested", "server-error"]);
		const entries = await root.entries({}, 1000, undefined, context);
		expect(
			entries.items.flatMap((entry) => entry.model ?? []).filter((message) => message.role === "toolResult"),
		).toHaveLength(3);
		expect(entries.items.filter((entry) => entry.kind === "pi.nested-tool-result")).toHaveLength(2);
		expect(reports).toEqual([]);
	});

	it("applies validation, ordinary vetoes, and critical policy to direct and sandbox calls", async () => {
		const { run, mcp, policies, calls } = await setup();
		const invalidCases: JsonObject[] = [{}, { text: "veto" }, { text: "denied" }];
		for (const args of invalidCases) {
			expect((await run(mcp.name, args)).isError).toBe(true);
			const result = await run("codemode", { code: `await tools.mcp__fixture__echo(${JSON.stringify(args)});` });
			expect(result.isError).toBe(true);
		}
		expect(calls()).toEqual([]);
		expect(policies).toEqual(["denied", "denied"]);
	});

	it("commits store writes only after success and forks the values at the selected entry", async () => {
		const { run, harness, root } = await setup();
		await run("codemode", { code: 'store("value", "one"); return load("value");' });
		const forkPoint = (await root.entries({}, 1, undefined, context)).items[0]!;
		await run("codemode", { code: 'store("value", "two");' });
		expect((await harness.snapshot(DurableCodemodeStore, root.id, context))?.values).toEqual({ value: "two" });
		const child = await root.fork(forkPoint.id, { ownership: { kind: "ownerless" } }, context);
		expect(text(await run("codemode", { code: 'return load("value");' }, child))).toContain("one");
		expect(
			(await run("codemode", { code: 'store("value", "bad"); throw new Error("script failure");' }, child)).isError,
		).toBe(true);
		expect((await harness.snapshot(DurableCodemodeStore, child.id, context))?.values).toEqual({ value: "one" });
		expect((await harness.snapshot(DurableCodemodeStore, root.id, context))?.values).toEqual({ value: "two" });
	});

	it("blocks a nested mutation on an unresolved effect without reaching the MCP server", async () => {
		const { run, registry, calls, mcp, root, faux } = await setup();
		const inject = defineTool({
			name: "inject_ambiguity",
			description: "Fixture inserts a recovered unresolved effect",
			parameters: Type.Object({}),
			effect: "read",
			execute: async (_args, api, ctx) => {
				await api.commit(async (tx) => {
					const ledger = await tx.doc(ToolEffectsDoc, `conversation:${api.conversationId}`, null);
					ledger.effects.uncertain = {
						taskId: 999_999 as TaskId,
						callId: "previous",
						tool: "mcp__fixture__echo",
						status: "pending",
					};
				}, ctx);
				return { content: [{ type: "text", text: "inserted" }] };
			},
		});
		registry.install(defineExtension({ name: "fixture-only", tools: [inject] }));
		const nested = await run("codemode", {
			code: 'await tools.inject_ambiguity({}); await tools.mcp__fixture__echo({text:"must not execute"});',
		});
		expect(nested.isError).toBe(true);
		expect(text(nested)).toMatch(/unresolved tool effect/i);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(mcp.name, { text: "still blocked" })], { stopReason: "toolUse" }),
		]);
		const retry = await root.submit({ type: "input", content: "try again" }, context);
		expect((await retry.wait(context)).status).toBe("unanswered");
		expect(calls()).toEqual([]);
	});
});
